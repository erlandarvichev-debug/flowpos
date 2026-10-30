import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service';
import { Permission, hasPermission } from './roles';
import { MfaService } from '../../auth/mfa.service';

export interface OrgContext {
  /** Клиент организации — из членства в БД, не из запроса. */
  tenantId: string;
  organizationId: string;
  userId: string;
  role: string;
  can: (p: Permission) => boolean;
}

export const REQUIRE_PERMISSION = 'acc:permission';
export const RequirePermission = (p: Permission) => SetMetadata(REQUIRE_PERMISSION, p);

/**
 * FP-008: привилегированная операция — сессия должна быть подтверждена вторым фактором.
 * Действует в production; вне его — при MFA_ENFORCE=1 (в веб-интерфейсе ещё нет экрана MFA).
 */
export const REQUIRE_MFA = 'acc:mfa';
export const RequireMfa = () => SetMetadata(REQUIRE_MFA, true);
export const mfaEnforced = () => process.env.MFA_ENFORCE === '1' || (process.env.NODE_ENV === 'production' && process.env.MFA_ENFORCE !== '0');

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

    // Доступ к организации — только по членству (FP-008). Прежнее «ленивое» назначение владельцем по роли
    // admin из токена убрано: роли в токене не проверяются сервером, а членства старых пользователей
    // созданы миграцией sql/pre/030.
    const membership = await this.prisma.orgMembership.findUnique({
      where: { userId_organizationId: { userId: user.sub, organizationId } },
    });
    if (!membership || !membership.isActive) {
      throw new ForbiddenException('Нет доступа к этой организации');
    }
    const role = membership.role;
    req.orgContext = {
      tenantId: membership.tenantId, organizationId, userId: user.sub, role,
      can: (p: Permission) => hasPermission(role, p),
    } as OrgContext;

    const required = this.reflector.getAllAndOverride<Permission>(REQUIRE_PERMISSION, [ctx.getHandler(), ctx.getClass()]);
    if (required && !hasPermission(role, required)) {
      throw new ForbiddenException(`Недостаточно прав: требуется «${required}» (ваша роль: ${role})`);
    }
    if (mfaEnforced() && this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA, [ctx.getHandler(), ctx.getClass()])) {
      MfaService.requireStepUp(user.mfaAt);
    }
    return true;
  }
}
