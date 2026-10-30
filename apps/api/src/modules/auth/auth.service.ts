import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { MfaService } from './mfa.service';

/** Сессия живёт не дольше этого срока, сколько бы раз ни обновлялся токен. */
export const SESSION_TTL_DAYS = 30;
/** Access-токен короткий: отзыв сессии действует не позже чем через этот срок даже без проверки сессии. */
export const ACCESS_TTL = process.env.JWT_EXPIRES_IN || '15m';
/** Сколько ждать код второго фактора после верного пароля. */
export const MFA_CHALLENGE_TTL = '5m';

/** В БД хранится только хэш refresh-токена: утечка таблицы не даёт рабочих токенов. */
export const hashToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/** Отозвать все действующие сессии пользователя (смена пароля, отключение, «выйти везде»). */
export async function revokeUserSessions(db: Prisma.TransactionClient | PrismaService, userId: string, reason: string, exceptSessionId?: string) {
  const now = new Date();
  const where = { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) };
  const { count } = await db.authSession.updateMany({ where, data: { revokedAt: now, revokedReason: reason } });
  await db.refreshToken.updateMany({ where: { userId, revokedAt: null, ...(exceptSessionId ? { sessionId: { not: exceptSessionId } } : {}) }, data: { revokedAt: now } });
  return count;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private mfa: MfaService,
  ) {}

  async login(dto: LoginDto, client: ClientInfo = {}) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: {
        userRoles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
        organization: true,
      },
    });

    if (!user || !user.isActive) throw new UnauthorizedException('Неверный email или пароль');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Неверный email или пароль');

    // Второй фактор включён — сессии ещё нет: короткий токен-вызов, который обменивается на сессию по коду.
    if (user.mfaEnabledAt) {
      return { mfaRequired: true as const, mfaToken: this.jwt.sign({ sub: user.id, purpose: 'mfa' }, { expiresIn: MFA_CHALLENGE_TTL }) };
    }
    return this.openSession(user.id, 'password', client, null);
  }

  /** Второй шаг входа: токен-вызов + код из приложения (или код восстановления) → сессия, подтверждённая MFA. */
  async completeMfaLogin(mfaToken: string, code: string, client: ClientInfo = {}) {
    let payload: any;
    try {
      payload = this.jwt.verify(mfaToken);
    } catch {
      throw new UnauthorizedException({ code: 'MFA_CHALLENGE_INVALID', message: 'Время подтверждения истекло — войдите снова' });
    }
    if (payload?.purpose !== 'mfa' || !payload.sub) throw new UnauthorizedException({ code: 'MFA_CHALLENGE_INVALID', message: 'Недействительный вызов' });
    await this.mfa.checkCode(payload.sub, code);
    return this.openSession(payload.sub, 'password', client, new Date());
  }

  private async openSession(userId: string, authMethod: string, client: ClientInfo, mfaAt: Date | null) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        userRoles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
        organization: true,
      },
    });
    if (!user.isActive) throw new UnauthorizedException('Пользователь неактивен');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const roles = user.userRoles.map((ur) => ur.role.name);
    const permissions = user.userRoles
      .flatMap((ur) => ur.role.permissions)
      .map((rp) => `${rp.permission.module}:${rp.permission.action}:${rp.permission.resource}`);

    const session = await this.prisma.authSession.create({
      data: {
        tenantId: user.tenantId, userId: user.id, authMethod, mfaAt,
        expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000),
        ip: client.ip?.slice(0, 64), userAgent: client.userAgent?.slice(0, 256),
      },
    });
    const accessToken = this.signAccess(user.id, session.id, user.email, user.tenantId, user.organizationId, roles);
    const refreshToken = await this.createRefreshToken(this.prisma, user.id, session.id, session.expiresAt);

    return {
      mfaRequired: false as const,
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tenantId: user.tenantId,
        organizationId: user.organizationId,
        organization: user.organization,
        roles,
        permissions: [...new Set(permissions)],
        mfaEnabled: !!user.mfaEnabledAt,
      },
    };
  }

  /**
   * Ротация: старый refresh-токен отзывается, выдаётся новый в той же сессии.
   * Повтор уже отозванного токена — признак кражи: отзывается вся сессия.
   */
  async refresh(rawToken: string) {
    const record = await this.prisma.refreshToken.findUnique({ where: { token: hashToken(rawToken) }, include: { session: true } });
    if (!record || !record.session) throw new UnauthorizedException('Refresh token недействителен');
    if (record.revokedAt) {
      if (!record.session.revokedAt) {
        await this.prisma.authSession.update({ where: { id: record.session.id }, data: { revokedAt: new Date(), revokedReason: 'REFRESH_REUSE' } });
        await this.prisma.refreshToken.updateMany({ where: { sessionId: record.session.id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      throw new UnauthorizedException('Refresh token недействителен');
    }
    const now = new Date();
    if (record.expiresAt < now || record.session.revokedAt || record.session.expiresAt < now) {
      throw new UnauthorizedException('Сессия завершена — войдите снова');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Пользователь неактивен');

    return this.prisma.$transaction(async (tx) => {
      // Условное обновление: из двух одновременных обновлений одним токеном выигрывает одно.
      const { count } = await tx.refreshToken.updateMany({ where: { id: record.id, revokedAt: null }, data: { revokedAt: now } });
      if (count !== 1) throw new UnauthorizedException('Refresh token недействителен');
      await tx.authSession.update({ where: { id: record.session!.id }, data: { lastUsedAt: now } });
      const roles = user.userRoles.map((ur) => ur.role.name);
      const accessToken = this.signAccess(user.id, record.session!.id, user.email, user.tenantId, user.organizationId, roles);
      const newRefreshToken = await this.createRefreshToken(tx, user.id, record.session!.id, record.session!.expiresAt);
      return { accessToken, refreshToken: newRefreshToken };
    });
  }

  /** Выход: отзывается вся сессия, и её access-токены перестают действовать сразу. */
  async logout(rawToken: string) {
    const record = await this.prisma.refreshToken.findUnique({ where: { token: hashToken(rawToken) } });
    if (record?.sessionId) await this.revokeSession(record.userId, record.sessionId, 'LOGOUT');
  }

  async logoutSession(userId: string, sessionId: string) {
    await this.revokeSession(userId, sessionId, 'LOGOUT');
  }

  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: { organization: true, userRoles: { include: { role: true } } },
    });
  }

  async sessions(userId: string, currentSessionId: string) {
    const rows = await this.prisma.authSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, authMethod: true, createdAt: true, lastUsedAt: true, expiresAt: true, ip: true, userAgent: true },
      orderBy: { lastUsedAt: 'desc' },
    });
    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  /** Отозвать свою сессию (например, забытый вход на чужом компьютере). Чужая сессия — 404. */
  async revokeSession(userId: string, sessionId: string, reason = 'USER_REVOKED') {
    const { count } = await this.prisma.authSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    if (!count && reason === 'USER_REVOKED') throw new NotFoundException('Сессия не найдена');
    await this.prisma.refreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  /** «Выйти на всех остальных устройствах». */
  async revokeOtherSessions(userId: string, currentSessionId: string) {
    return { revoked: await revokeUserSessions(this.prisma, userId, 'USER_REVOKED_OTHERS', currentSessionId) };
  }

  /** tenantId/organizationId в токене — подсказка для клиента; права и область сервер берёт из БД. */
  private signAccess(sub: string, sid: string, email: string, tenantId: string, organizationId: string, roles: string[]) {
    return this.jwt.sign({ sub, sid, email, tenantId, organizationId, roles }, { expiresIn: ACCESS_TTL });
  }

  private async createRefreshToken(db: Prisma.TransactionClient | PrismaService, userId: string, sessionId: string, sessionExpiresAt: Date) {
    const token = randomBytes(48).toString('hex');
    await db.refreshToken.create({ data: { userId, sessionId, token: hashToken(token), expiresAt: sessionExpiresAt } });
    return token;
  }
}
