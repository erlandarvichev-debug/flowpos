import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuthUser {
  sub: string;
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
   * Клиент (tenant) и организация пользователя — из БД, а не из токена: токен подтверждает только «кто».
   * Отключённый или удалённый пользователь теряет доступ сразу, а не по истечении токена.
   */
  async validate(payload: any): Promise<AuthUser> {
    const user = payload?.sub
      ? await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { tenantId: true, organizationId: true, isActive: true } })
      : null;
    if (!user || !user.isActive) throw new UnauthorizedException('Пользователь неактивен');
    return {
      sub: payload.sub,
      email: payload.email,
      tenantId: user.tenantId,
      organizationId: user.organizationId,
      roles: payload.roles,
    };
  }
}
