import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { bindRequestTenant, runAsSystem } from '../../common/db-context';

export interface AuthUser {
  sub: string;
  sid: string;
  /** Когда сессия подтверждена вторым фактором; null — не подтверждена. */
  mfaAt: Date | null;
  email: string;
  tenantId: string;
  organizationId: string;
  roles: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'flowpos-secret',
    });
  }

  /**
   * Клиент (tenant) и организация пользователя — из БД, а не из токена: токен подтверждает только «кто» и сессию.
   * Токен действует, пока жива его сессия (FP-008): выход, отзыв сессии, смена пароля или отключение
   * пользователя закрывают доступ сразу, а не по истечении токена. Токен без сессии (выдан до FP-008) — 401.
   */
  async validate(payload: any): Promise<AuthUser> {
    // Клиент ещё неизвестен — сессия читается в системном режиме; дальше запрос работает от имени её клиента (FP-009).
    const session = payload?.sub && payload?.sid
      ? await runAsSystem(() => this.prisma.authSession.findUnique({
          where: { id: payload.sid },
          select: { userId: true, revokedAt: true, expiresAt: true, mfaAt: true, user: { select: { tenantId: true, organizationId: true, isActive: true } } },
        }))
      : null;
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Сессия завершена — войдите снова');
    }
    const user = session.user;
    if (!user.isActive) throw new UnauthorizedException('Пользователь неактивен');
    bindRequestTenant(user.tenantId);
    return {
      sub: payload.sub,
      sid: payload.sid,
      mfaAt: session.mfaAt,
      email: payload.email,
      tenantId: user.tenantId,
      organizationId: user.organizationId,
      roles: payload.roles,
    };
  }
}
