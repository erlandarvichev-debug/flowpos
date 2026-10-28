import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service';
import { Permission, hasPermission } from './roles';

export interface OrgContext {
  organizationId: string;
  userId: string;
  role: string;
  can: (p: Permission) => boolean;
}

export const REQUIRE_PERMISSION = 'acc:permission';
export const RequirePermission = (p: Permission) => SetMetadata(REQUIRE_PERMISSION, p);

export const Org = createParamDecorator((_: unknown, ctx: ExecutionContext): OrgContext => {
  return ctx.switchToHttp().getRequest().orgContext;
});

/**
 * Определяет организацию запроса (заголовок X-Organization-Id, по умолчанию — организация пользователя),
 * проверяет членство и право из @RequirePermission. Чужая организация → 403.
 * Применяется после JwtAuthGuard.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user?.sub) throw new ForbiddenException('Нет пользователя');
    const header = req.headers['x-organization-id'];
    const organizationId = (Array.isArray(header) ? header[0] : header) || user.organizationId;

    let membership = await this.prisma.orgMembership.findUnique({
      where: { userId_organizationId: { userId: user.sub, organizationId } },
    });
    // Ленивая миграция: администратор платформы получает роль владельца в своей организации
    if (!membership && organizationId === user.organizationId && (user.roles || []).includes('admin')) {
      membership = await this.prisma.orgMembership.create({
        data: { userId: user.sub, organizationId, role: 'owner' },
      });
      await this.prisma.auditLog.create({
        data: { userId: user.sub, organizationId, action: 'MEMBERSHIP_AUTO_OWNER', entity: 'OrgMembership', entityId: membership.id },
      });
    }
    if (!membership || !membership.isActive) {
      throw new ForbiddenException('Нет доступа к этой организации');
    }
    const role = membership.role;
    req.orgContext = {
      organizationId, userId: user.sub, role,
      can: (p: Permission) => hasPermission(role, p),
    } as OrgContext;

    const required = this.reflector.getAllAndOverride<Permission>(REQUIRE_PERMISSION, [ctx.getHandler(), ctx.getClass()]);
    if (required && !hasPermission(role, required)) {
      throw new ForbiddenException(`Недостаточно прав: требуется «${required}» (ваша роль: ${role})`);
    }
    return true;
  }
}
