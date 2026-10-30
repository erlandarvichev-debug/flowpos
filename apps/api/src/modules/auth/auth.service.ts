import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';

const REFRESH_TTL_DAYS = 30;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
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

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const roles = user.userRoles.map((ur) => ur.role.name);
    const permissions = user.userRoles
      .flatMap((ur) => ur.role.permissions)
      .map((rp) => `${rp.permission.module}:${rp.permission.action}:${rp.permission.resource}`);

    const accessToken = this.signAccess(user.id, user.email, user.tenantId, user.organizationId, roles);
    const refreshToken = await this.createRefreshToken(user.id);

    return {
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
      },
    };
  }

  async refresh(rawToken: string) {
    const record = await this.prisma.refreshToken.findUnique({ where: { token: rawToken } });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token недействителен');
    }

    // Rotate: revoke old, issue new
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Пользователь неактивен');

    const roles = user.userRoles.map((ur) => ur.role.name);
    const accessToken = this.signAccess(user.id, user.email, user.tenantId, user.organizationId, roles);
    const newRefreshToken = await this.createRefreshToken(user.id);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(rawToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { token: rawToken, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: { organization: true, userRoles: { include: { role: true } } },
    });
  }

  /** tenantId/organizationId в токене — подсказка для клиента; права и область сервер берёт из БД. */
  private signAccess(sub: string, email: string, tenantId: string, organizationId: string, roles: string[]) {
    return this.jwt.sign({ sub, email, tenantId, organizationId, roles });
  }

  private async createRefreshToken(userId: string) {
    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
    await this.prisma.refreshToken.create({ data: { userId, token, expiresAt } });
    return token;
  }
}
