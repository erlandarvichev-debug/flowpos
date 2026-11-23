import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { tenantCatalog } from '../../common/scope';
import { OrgContext } from '../accounting/access/org-context';

/**
 * Поиск по всей системе (строка в шапке): товары (название, код, артикул, штрихкод), контрагенты (название, БИН/ИИН,
 * телефон), документы (номер). Только то, на что у роли есть права; по 6 результатов в группе.
 */
@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  async search(ctx: OrgContext, raw: string) {
    const q = String(raw ?? '').trim().slice(0, 100);
    if (q.length < 2) return { query: q, products: [], counterparties: [], documents: [] };
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId, role: ctx.role };
    const like = { contains: q, mode: 'insensitive' as const };
    const digits = /^\d{6,}$/.test(q);

    const products = ctx.can('catalog.read')
      ? await this.prisma.product.findMany({
          where: { ...tenantCatalog(scope), deleted: false, AND: [{ OR: [{ name: like }, { code: like }, { article: like }, ...(digits ? [{ barcodes: { some: { barcode: q } } }] : [])] }] },
          select: { id: true, name: true, code: true, article: true, kind: true },
          orderBy: { name: 'asc' }, take: 6,
        })
      : [];
    const counterparties = ctx.can('catalog.read')
      ? await this.prisma.counterparty.findMany({
          where: { ...tenantCatalog(scope), deleted: false, AND: [{ OR: [{ name: like }, { inn: { startsWith: q } }, { phone: like }] }] },
          select: { id: true, name: true, inn: true, type: true },
          orderBy: { name: 'asc' }, take: 6,
        })
      : [];
    const documents = ctx.can('acc.doc.read')
      ? await this.prisma.document.findMany({
          where: { organizationId: ctx.organizationId, number: like },
          select: { id: true, number: true, docType: true, date: true, total: true, status: true, counterparty: { select: { name: true } } },
          orderBy: { date: 'desc' }, take: 6,
        })
      : [];
    return { query: q, products, counterparties, documents };
  }
}
