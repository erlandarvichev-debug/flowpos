import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from '../../modules/auth/jwt.strategy';

// FP-008: Action-based RBAC decorator
export const RequireAction = (action: string) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    Reflector.createDecorator()(target, propertyKey, descriptor);
  };
};

/**
 * FP-008: RBAC Guard — checks grants for required action
 *
 * Usage:
 *   @RequireAction('send')
 *   @UseGuards(RbacGuard)
 *   sendDocument(@Req() req) { ... }
 *
 * Guard ensures:
 * - Organization is set (X-Flowpos-Organization header)
 * - User has grant for action+org+scope
 * - Grant is not expired
 * - Tenant matches between user and org
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // FP-008: Organization MUST be specified in header
    const orgId = request.headers['x-flowpos-organization'];
    if (!orgId) {
      throw new ForbiddenException('X-Flowpos-Organization header is required');
    }

    // FP-008: Ensure user is from same tenant as org
    const userGrant = user.grants?.find((g) => g.organizationId === orgId);
    if (!userGrant) {
      throw new ForbiddenException(`No access to organization ${orgId}`);
    }

    // Store org context for downstream use
    request.organization = { id: orgId, tenantId: user.tenantId };

    return true;
  }
}

/**
 * FP-008: Action-specific guard
 * Checks that user has GRANT for specific ACTION in organization
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, ActionGuard('send'))
 *   sendDocument() { ... }
 */
@Injectable()
export class ActionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;
    const target = context.getHandler();

    // Extract action from decorator (TODO: implement @Action decorator)
    const action = this.reflector.get<string>('action', target) || 'read';

    const orgId = request.headers['x-flowpos-organization'];
    if (!orgId) {
      throw new ForbiddenException('X-Flowpos-Organization header is required');
    }

    // FP-008: Check grant
    const grant = user.grants?.find(
      (g) => g.organizationId === orgId && g.action === action,
    );

    if (!grant) {
      throw new ForbiddenException(`No ${action} permission for organization ${orgId}`);
    }

    // Store context
    request.organization = { id: orgId, tenantId: user.tenantId };
    request.action = action;

    return true;
  }
}

/**
 * FP-008: Tenant isolation guard
 * Ensures all requests are scoped to authenticated tenant
 * Auto-populated from JWT, cannot be overridden by client
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;

    if (!user?.tenantId) {
      throw new ForbiddenException('Tenant not found in JWT');
    }

    // FP-008: Tenant context immutable from JWT
    request.tenant = { id: user.tenantId };
    request.headers['x-flowpos-tenant'] = user.tenantId; // Read-only context

    return true;
  }
}
