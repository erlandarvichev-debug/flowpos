// FP-028: граф документов — основания, сторно, ЭСФ по документу, исправленные ЭСФ — в обе стороны от выбранного.
// Связи ведёт БД (document_links, триггеры по ссылкам самих документов); здесь — обход и краткие карточки узлов.
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';

export type DocType = 'TRADE' | 'ACC' | 'ESF';
const TYPES: DocType[] = ['TRADE', 'ACC', 'ESF'];
const MAX_NODES = 200;

export interface GraphNode {
  key: string; // TYPE:id
  type: DocType;
  id: string;
  kind: string; // вид документа
  number: string | null;
  date: string | null;
  status: string;
  amount: string | null;
  version?: number;
  postedVersion?: number | null;
}

@Injectable()
export class DocumentGraphService {
  constructor(private prisma: PrismaService) {}

  /** Карточки узлов своей организации (чужие и несуществующие не возвращаются). */
  private async nodes(ctx: OrgContext, keys: { type: DocType; id: string }[]): Promise<GraphNode[]> {
    const ids = (t: DocType) => keys.filter((k) => k.type === t).map((k) => k.id);
    const org = ctx.organizationId;
    const stores = (await this.prisma.store.findMany({ where: { organizationId: org }, select: { id: true } })).map((s) => s.id);
    const [trade, acc, esf] = await Promise.all([
      ids('TRADE').length ? this.prisma.document.findMany({ where: { id: { in: ids('TRADE') }, OR: [{ organizationId: org }, { organizationId: null, storeId: { in: stores } }] } }) : [],
      ids('ACC').length ? this.prisma.accDocument.findMany({ where: { id: { in: ids('ACC') }, organizationId: org } }) : [],
      ids('ESF').length ? this.prisma.esfInvoice.findMany({ where: { id: { in: ids('ESF') }, organizationId: org } }) : [],
    ]);
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return [
      ...trade.map((d) => ({ key: `TRADE:${d.id}`, type: 'TRADE' as const, id: d.id, kind: d.docType, number: d.number, date: day(d.date), status: d.status, amount: d.total?.toFixed(2) ?? null, version: d.version, postedVersion: d.postedVersion })),
      ...acc.map((d) => ({ key: `ACC:${d.id}`, type: 'ACC' as const, id: d.id, kind: d.docType, number: d.number, date: day(d.date), status: d.status, amount: d.amount.toFixed(2), version: d.version, postedVersion: d.postedVersion })),
      ...esf.map((d) => ({ key: `ESF:${d.id}`, type: 'ESF' as const, id: d.id, kind: `ESF_${d.direction}_${d.invoiceType}`, number: d.registrationNumber ?? d.num, date: day(d.date), status: d.status, amount: d.totalWithTax.toFixed(2) })),
    ];
  }

  /**
   * Граф от документа: обход связей в обе стороны до заданной глубины (по умолчанию 5). Узлы и связи — только
   * своей организации; кольца не зацикливают обход. Корень другой организации — «не найден».
   */
  async graph(ctx: OrgContext, type: string, id: string, depthRaw?: unknown) {
    if (!TYPES.includes(type as DocType)) throw new AccError('BAD_TYPE', `Тип документа: ${TYPES.join(', ')}`);
    const depth = Math.min(Math.max(Number(depthRaw ?? 5) || 5, 1), 10);
    const [root] = await this.nodes(ctx, [{ type: type as DocType, id }]);
    if (!root) throw new AccError('DOC_NOT_FOUND', 'Документ не найден', { status: 404 });

    const seen = new Set<string>([root.key]);
    const edges = new Map<string, { from: string; to: string; kind: string }>();
    let frontier = [{ type: root.type, id: root.id }];
    for (let level = 0; level < depth && frontier.length && seen.size < MAX_NODES; level++) {
      const or = frontier.flatMap((f) => [{ fromType: f.type, fromId: f.id }, { toType: f.type, toId: f.id }]);
      const links = await this.prisma.documentLink.findMany({ where: { organizationId: ctx.organizationId, OR: or } });
      const next: { type: DocType; id: string }[] = [];
      for (const l of links) {
        const from = `${l.fromType}:${l.fromId}`, to = `${l.toType}:${l.toId}`;
        edges.set(`${from}>${to}>${l.kind}`, { from, to, kind: l.kind });
        for (const [t, i, k] of [[l.fromType, l.fromId, from], [l.toType, l.toId, to]] as const) {
          if (!seen.has(k) && seen.size < MAX_NODES) {
            seen.add(k);
            next.push({ type: t as DocType, id: i });
          }
        }
      }
      frontier = next;
    }
    const all = await this.nodes(ctx, [...seen].map((k) => ({ type: k.split(':')[0] as DocType, id: k.slice(k.indexOf(':') + 1) })));
    const keys = new Set(all.map((n) => n.key));
    return {
      root: root.key,
      nodes: all.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.key.localeCompare(b.key)),
      edges: [...edges.values()].filter((e) => keys.has(e.from) && keys.has(e.to)),
      truncated: seen.size >= MAX_NODES,
    };
  }
}
