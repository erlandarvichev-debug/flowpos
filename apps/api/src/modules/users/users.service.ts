import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(organizationId: string) {
    return this.prisma.user.findMany({
      where: { organizationId },
      include: { userRoles: { include: { role: true } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { userRoles: { include: { role: true } }, organization: true },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }

  async create(data: any) {
    const exists = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw new ConflictException('Email уже используется');
    const passwordHash = await bcrypt.hash(data.password, 10);
    const { password, roleIds, ...rest } = data;
    const user = await this.prisma.user.create({
      data: {
        ...rest,
        passwordHash,
        userRoles: roleIds ? { create: roleIds.map((id: string) => ({ roleId: id })) } : undefined,
      },
      include: { userRoles: { include: { role: true } } },
    });
    return user;
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    const { password, roleIds, ...rest } = data;
    const updateData: any = { ...rest };
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);
    return this.prisma.user.update({
      where: { id },
      data: updateData,
      include: { userRoles: { include: { role: true } } },
    });
  }

  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.user.update({ where: { id }, data: { isActive: false } });
  }
}
