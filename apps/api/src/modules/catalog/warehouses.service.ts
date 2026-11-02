import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope, ownOrg, scopeError, writable } from '../../common/scope';

/** Склады — объекты организации (FP-007). */
@Injectable()
export class WarehousesService {
  constructor(private prisma: PrismaService) {}

  async findAll(s: Scope) {
    // FP-032: служебный склад «В пути» в выборе складов не показывается (движения на него — только перемещение в два этапа).
    return this.prisma.store.findMany({
      where: { ...ownOrg(s), isActive: true, isTransit: false },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(s: Scope, id: string) {
    const w = await this.prisma.store.findFirst({
      where: { id, ...ownOrg(s) },
      include: { bins: { orderBy: [{ code: 'asc' }, { name: 'asc' }] } },
    });
    if (!w) throw new NotFoundException('Склад не найден');
    return w;
  }

  async create(s: Scope, body: any) {
    const { data } = writable(body, s);
    delete (data as any).isTransit; // «В пути» создаёт только система
    return this.prisma.store.create({ data: { ...(data as any), tenantId: s.tenantId, organizationId: s.organizationId } }).catch(scopeError);
  }

  async update(s: Scope, id: string, body: any) {
    await this.findOne(s, id);
    const { data } = writable(body, s);
    delete (data as any).isTransit;
    return this.prisma.store.update({ where: { id }, data: data as any }).catch(scopeError);
  }

  // ── FP-032: ячейки (адреса хранения) ──

  private binData(body: any) {
    const d: any = {};
    for (const k of ['name', 'code', 'row', 'section', 'level'] as const) if (body?.[k] !== undefined) d[k] = body[k] === '' ? null : String(body[k]).trim();
    if (body?.isActive !== undefined) d.isActive = !!body.isActive;
    return d;
  }

  async createBin(s: Scope, storeId: string, body: any) {
    await this.findOne(s, storeId);
    const d = this.binData(body);
    if (!d.name) throw new BadRequestException({ code: 'BIN_NAME_REQUIRED', message: 'Укажите название ячейки' });
    if (d.code && (await this.prisma.bin.findFirst({ where: { storeId, code: d.code } }))) throw new BadRequestException({ code: 'BIN_CODE_TAKEN', message: `Ячейка с кодом ${d.code} на этом складе уже есть` });
    return this.prisma.bin.create({ data: { ...d, storeId } });
  }

  /** Изменить ячейку; выключить можно только пустую (без остатка). */
  async updateBin(s: Scope, storeId: string, binId: string, body: any) {
    await this.findOne(s, storeId);
    const bin = await this.prisma.bin.findFirst({ where: { id: binId, storeId } });
    if (!bin) throw new NotFoundException('Ячейка не найдена');
    const d = this.binData(body);
    if (d.code && d.code !== bin.code && (await this.prisma.bin.findFirst({ where: { storeId, code: d.code, id: { not: binId } } }))) throw new BadRequestException({ code: 'BIN_CODE_TAKEN', message: `Ячейка с кодом ${d.code} на этом складе уже есть` });
    if (d.isActive === false && (await this.prisma.stock.count({ where: { binId, qty: { not: 0 } } }))) {
      throw new BadRequestException({ code: 'BIN_NOT_EMPTY', message: 'В ячейке есть товар — сначала переместите его в другую ячейку' });
    }
    return this.prisma.bin.update({ where: { id: binId }, data: d });
  }

  async getStocks(s: Scope, id: string, query: { search?: string; page?: number; limit?: number }) {
    await this.findOne(s, id);
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = { storeId: id, qty: { gt: 0 } };
    if (query.search) {
      where.product = { name: { contains: query.search, mode: 'insensitive' } };
    }

    const [stocks, total] = await Promise.all([
      this.prisma.stock.findMany({
        where,
        skip,
        take: limit,
        include: { product: { include: { uom: true } }, bin: true },
        orderBy: { product: { name: 'asc' } },
      }),
      this.prisma.stock.count({ where }),
    ]);

    return { stocks, total, page, limit };
  }
}
