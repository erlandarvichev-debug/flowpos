import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError } from '../../common/scope';
import { revokeUserSessions } from '../auth/auth.service';
import { LEGACY_ROLE_TO_ORG_ROLE, ROLES, canGrant } from '../accounting/access/roles';

/** Поля, которые пользователь может задать сам; остальное (клиент, организация, хэш, даты) — сервер. */
const EDITABLE = ['email', 'firstName', 'lastName', 'middleName', 'phone', 'isActive'] as const;
const pick = (b: any) => Object.fromEntries(EDITABLE.filter((k) => b?.[k] !== undefined).map((k) => [k, b[k]]));

/**
 * Пользователи своей организации (FP-007). Управлять ими может только роль с org.members.manage (FP-008);
 * права даёт роль в организации — назначить можно только роль, все права которой есть у назначающего.
 */
@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(s: Scope) {
    return this.prisma.user.findMany({
      where: { tenantId: s.tenantId, organizationId: s.organizationId },
      include: { userRoles: { include: { role: true } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  async findOne(s: Scope, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, tenantId: s.tenantId, organizationId: s.organizationId },
      include: { userRoles: { include: { role: true } }, organization: true },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }

  /** Роль в организации из запроса: явная `role` или отмеченные роли старого модуля (форма «Пользователи»). */
  private async requestedRole(body: any): Promise<string | undefined> {
    if (body?.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new BadRequestException({ code: 'BAD_ROLE', message: 'Неизвестная роль' });
      return body.role;
    }
    if (!Array.isArray(body?.roleIds)) return undefined;
    const legacy = await this.prisma.role.findMany({ where: { id: { in: body.roleIds } }, select: { name: true } });
    // Несколько отмеченных — берётся самая широкая по правам из тех, что известны.
    const mapped = legacy.map((r) => LEGACY_ROLE_TO_ORG_ROLE[r.name]).filter(Boolean);
    return ['admin', 'manager', 'hr', 'cashier'].find((r) => mapped.includes(r as any));
  }

  private assertCanGrant(s: Scope, role: string) {
    if (!s.role || !canGrant(s.role, role)) {
      throw new ForbiddenException({ code: 'ROLE_ESCALATION', message: `Нельзя назначить роль «${role}»: у вас нет всех её прав` });
    }
  }

  async create(s: Scope, body: any) {
    const role = await this.requestedRole(body);
    if (!role) throw new BadRequestException({ code: 'ROLE_REQUIRED', message: 'Выберите роль пользователя' });
    this.assertCanGrant(s, role);
    const exists = await this.prisma.user.findUnique({ where: { email: body?.email } });
    if (exists) throw new ConflictException('Email уже используется');
    const passwordHash = await bcrypt.hash(body.password, 10);
    const roleIds: string[] | undefined = body?.roleIds;
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          ...(pick(body) as any),
          tenantId: s.tenantId,
          organizationId: s.organizationId,
          passwordHash,
          userRoles: roleIds ? { create: roleIds.map((id) => ({ roleId: id })) } : undefined,
        },
        include: { userRoles: { include: { role: true } } },
      });
      await tx.orgMembership.create({ data: { tenantId: s.tenantId, userId: user.id, organizationId: s.organizationId, role } });
      await tx.auditLog.create({ data: { userId: s.userId, organizationId: s.organizationId, action: 'USER_CREATE', entity: 'User', entityId: user.id, after: { email: user.email, role } } });
      return user;
    }).catch(scopeError);
  }

  /** Менять можно только пользователя, чья роль в организации не шире своей (администратор не правит владельца). */
  private async assertCanManage(s: Scope, userId: string) {
    const m = await this.prisma.orgMembership.findUnique({ where: { userId_organizationId: { userId, organizationId: s.organizationId } } });
    if (m && userId !== s.userId) this.assertCanGrant(s, m.role);
    return m;
  }

  async update(s: Scope, id: string, body: any) {
    await this.findOne(s, id);
    const membership = await this.assertCanManage(s, id);
    const role = await this.requestedRole(body);
    if (role && role !== membership?.role) {
      if (id === s.userId) throw new ForbiddenException({ code: 'SELF_ROLE', message: 'Нельзя менять собственную роль' });
      this.assertCanGrant(s, role);
      await this.prisma.orgMembership.upsert({
        where: { userId_organizationId: { userId: id, organizationId: s.organizationId } },
        create: { tenantId: s.tenantId, userId: id, organizationId: s.organizationId, role },
        update: { role },
      });
      await this.prisma.auditLog.create({ data: { userId: s.userId, organizationId: s.organizationId, action: 'MEMBER_ROLE_SET', entity: 'User', entityId: id, before: { role: membership?.role ?? null }, after: { role } } });
    }
    const updateData: any = pick(body);
    if (body?.password) updateData.passwordHash = await bcrypt.hash(body.password, 10);
    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { userRoles: { include: { role: true } } },
    }).catch(scopeError);
    // Новый пароль или отключение — все входы пользователя завершаются (FP-008).
    if (body?.password) await revokeUserSessions(this.prisma, id, 'PASSWORD_CHANGED');
    else if (updateData.isActive === false) await revokeUserSessions(this.prisma, id, 'USER_DEACTIVATED');
    return updated;
  }

  async deactivate(s: Scope, id: string) {
    await this.findOne(s, id);
    await this.assertCanManage(s, id);
    const user = await this.prisma.user.update({ where: { id }, data: { isActive: false } });
    await revokeUserSessions(this.prisma, id, 'USER_DEACTIVATED');
    return user;
  }

  /** Завершить все входы пользователя своей организации (потерян телефон, увольнение). */
  async revokeSessions(s: Scope, id: string) {
    await this.findOne(s, id);
    await this.assertCanManage(s, id);
    return { revoked: await revokeUserSessions(this.prisma, id, 'ADMIN_REVOKED') };
  }
}
