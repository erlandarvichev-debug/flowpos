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
    // FP-008: Find user by email (tenant isolation via email uniqueness)
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, isActive: true },
      include: {
        tenant: true,
        organization: true,
        grants: { where: { expiresAt: { gt: new Date() } } },
      },
    });

    if (!user) throw new UnauthorizedException('Неверный email или пароль');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Неверный email или пароль');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // FP-008: Extract grants (action-based RBAC)
    const grants = user.grants.map((g) => ({
      organizationId: g.organizationId,
      action: g.action,
      scope: g.scope,
    }));

    // FP-008: JWT with tenantId, organizationId, grants (not roles)
    const accessToken = this.signAccess({
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      organizationId: user.organizationId,
      grants,
    });
    const refreshToken = await this.createRefreshToken(user.id, user.tenantId);

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
        grants,
      },
    };
  }

  async refresh(rawToken: string) {
    const record = await this.prisma.refreshToken.findUnique({ where: { token: rawToken } });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token недействителен');
    }

    // FP-008: Rotate: revoke old, issue new
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      include: {
        grants: { where: { expiresAt: { gt: new Date() } } },
      },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Пользователь неактивен');

    const grants = user.grants.map((g) => ({
      organizationId: g.organizationId,
      action: g.action,
      scope: g.scope,
    }));

    const accessToken = this.signAccess({
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      organizationId: user.organizationId,
      grants,
    });
    const newRefreshToken = await this.createRefreshToken(user.id, user.tenantId);

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

  // FP-008: Sign JWT with tenantId + grants (not roles)
  private signAccess(payload: {
    sub: string;
    email: string;
    tenantId: string;
    organizationId: string;
    grants: Array<{ organizationId: string; action: string; scope: string }>;
  }) {
    return this.jwt.sign(payload, { expiresIn: '15m' }); // 15min access token
  }

  private async createRefreshToken(userId: string, tenantId: string) {
    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
    await this.prisma.refreshToken.create({ data: { userId, tenantId, token, expiresAt } });
    return token;
  }
}
