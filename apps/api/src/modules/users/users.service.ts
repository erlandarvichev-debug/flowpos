import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, scopeError } from '../../common/scope';

/** Поля, которые пользователь может задать сам; остальное (клиент, организация, хэш, даты) — сервер. */
const EDITABLE = ['email', 'firstName', 'lastName', 'middleName', 'phone', 'isActive'] as const;
const pick = (b: any) => Object.fromEntries(EDITABLE.filter((k) => b?.[k] !== undefined).map((k) => [k, b[k]]));

/** Пользователи своей организации (FP-007). Кто вправе управлять пользователями — FP-008. */
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

  async create(s: Scope, body: any) {
    const exists = await this.prisma.user.findUnique({ where: { email: body?.email } });
    if (exists) throw new ConflictException('Email уже используется');
    const passwordHash = await bcrypt.hash(body.password, 10);
    const roleIds: string[] | undefined = body?.roleIds;
    return this.prisma.user.create({
      data: {
        ...(pick(body) as any),
        tenantId: s.tenantId,
        organizationId: s.organizationId,
        passwordHash,
        userRoles: roleIds ? { create: roleIds.map((id) => ({ roleId: id })) } : undefined,
      },
      include: { userRoles: { include: { role: true } } },
    }).catch(scopeError);
  }

  async update(s: Scope, id: string, body: any) {
    await this.findOne(s, id);
    const updateData: any = pick(body);
    if (body?.password) updateData.passwordHash = await bcrypt.hash(body.password, 10);
    return this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { userRoles: { include: { role: true } } },
    }).catch(scopeError);
  }

  async deactivate(s: Scope, id: string) {
    await this.findOne(s, id);
    return this.prisma.user.update({ where: { id }, data: { isActive: false } });
  }
}
