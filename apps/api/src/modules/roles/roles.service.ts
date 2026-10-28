import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class RolesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { displayName: 'asc' },
    });
  }

  async create(data: any) {
    const { permissionIds, ...rest } = data;
    return this.prisma.role.create({
      data: {
        ...rest,
        permissions: permissionIds
          ? { create: permissionIds.map((id: string) => ({ permissionId: id })) }
          : undefined,
      },
      include: { permissions: { include: { permission: true } } },
    });
  }

  async findPermissions() {
    return this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { action: 'asc' }] });
  }
}
