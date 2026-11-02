// FP-032: резервы под заказы покупателей. Свободно = факт − резервы. Сколько можно занять, проверяет БД под
// блокировкой (sql/110_fp032_reservations.sql); здесь — что резервировать, когда резерв расходуется и что расход
// товара не забирает чужой резерв.
import { Prisma } from '@prisma/client';
import { LEDGER_SOURCE, PlannedMove } from './stock-ledger';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;
const D = Prisma.Decimal;

export class ReserveError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: any, public fix?: string) { super(message); }
}

/** Ошибка БД резерва (RAISE 'КОД: …') → понятная ошибка; иначе — как есть. */
function dbReserveError(e: any): never {
  const msg = String(e?.meta?.message ?? e?.message ?? '');
  if (e?.code === 'P2002' || /stock_reservations_one_active_per_line/.test(msg)) {
    throw new ReserveError('RESERVE_CONFLICT', 'Резерв по этой строке уже меняется другим пользователем — обновите заказ и повторите', 409);
  }
  const m = msg.match(/RESERVE_INSUFFICIENT: ([^"`]*)/);
  if (m) throw new ReserveError('RESERVE_CONFLICT', `Свободный остаток изменился, пока резервировали (${m[1].trim()}) — повторите`, 409);
  throw e;
}

/** Действующие резервы документа. */
export function activeReservations(tx: Tx, sourceId: string) {
  return tx.stockReservation.findMany({ where: { sourceType: LEDGER_SOURCE, sourceId, remaining: { gt: 0 } }, orderBy: { sourceLine: 'asc' } });
}

/** Отгружено по заказу (проведённые реализации на его основании) — по товару. */
async function shippedByProduct(tx: Tx, orderId: string) {
  const docs = await tx.document.findMany({ where: { docType: 'DEMAND', status: 'POSTED', deleted: false, attributes: { path: ['baseId'], equals: orderId } }, include: { lines: true } });
  const m = new Map<string, Dec>();
  for (const d of docs) for (const l of d.lines) m.set(l.productId, (m.get(l.productId) ?? new D(0)).plus(l.qty));
  return m;
}

const available = async (tx: Tx, productId: string, storeId: string): Promise<Dec> =>
  new D((await tx.$queryRaw<{ a: string }[]>`SELECT fp_stock_available(${productId}, ${storeId})::text AS a`)[0].a);

/**
 * Зарезервировать заказ: по каждой строке — до (заказано − отгружено), сколько свободно. Строка, где резерв уже есть,
 * перерезервируется (прежний закрывается, новый — на нужное количество). Возвращает, что вышло по строкам.
 */
export async function reserveOrder(tx: Tx, order: { id: string; docType: string; storeId: string | null; organizationId: string | null; status: string; deleted: boolean; lines: { lineNo: number; productId: string; qty: any }[] }, userId: string) {
  if (order.docType !== 'CUSTOMER_ORDER') throw new ReserveError('RESERVE_NOT_ORDER', 'Резервировать можно только заказ покупателя');
  if (order.deleted || order.status === 'CANCELLED') throw new ReserveError('DOC_CANCELLED', 'Заказ помечен на удаление');
  if (!order.storeId) throw new ReserveError('STORE_REQUIRED', 'Укажите склад заказа — резерв делается на складе', 400, undefined, 'Выберите склад в заказе и сохраните.');
  const services = new Set((await tx.product.findMany({ where: { id: { in: order.lines.map((l) => l.productId) }, kind: 'SERVICE' }, select: { id: true } })).map((p) => p.id));
  const shipped = await shippedByProduct(tx, order.id);
  const active = await activeReservations(tx, order.id);
  const result: { lineNo: number; productId: string; ordered: string; shipped: string; reserved: string; shortfall: string }[] = [];
  for (const l of order.lines) {
    if (services.has(l.productId)) continue;
    const ordered = new D(l.qty);
    const avail0 = shipped.get(l.productId) ?? new D(0);
    const sh = D.min(avail0, ordered);
    shipped.set(l.productId, avail0.minus(sh)); // отгруженное распределяется по строкам заказа по порядку
    const target = ordered.minus(sh);
    const cur = active.find((r) => r.sourceLine === l.lineNo);
    let reserved = cur ? new D(cur.remaining) : new D(0);
    if (cur && (cur.storeId !== order.storeId || cur.productId !== l.productId || reserved.gt(target))) {
      // склад/товар строки сменили или нужно меньше — прежний резерв снимается целиком
      await tx.stockReservation.update({ where: { id: cur.id }, data: { remaining: 0, closedAt: new Date(), closeReason: 'RERESERVED' } });
      reserved = new D(0);
    }
    if (reserved.lt(target)) {
      const free = await available(tx, l.productId, order.storeId);
      const want = D.min(target, reserved.plus(D.max(free, 0)));
      if (want.gt(reserved)) {
        if (reserved.gt(0)) await tx.stockReservation.update({ where: { id: cur!.id }, data: { remaining: 0, closedAt: new Date(), closeReason: 'RERESERVED' } });
        try {
          await tx.stockReservation.create({ data: { organizationId: order.organizationId!, productId: l.productId, storeId: order.storeId, qty: want, remaining: want, sourceId: order.id, sourceLine: l.lineNo, createdBy: userId } });
        } catch (e) { dbReserveError(e); }
        reserved = want;
      }
    }
    result.push({ lineNo: l.lineNo, productId: l.productId, ordered: ordered.toString(), shipped: sh.toString(), reserved: reserved.toString(), shortfall: target.minus(reserved).toString() });
  }
  return result;
}

/** Снять резервы документа (весь остаток резерва). */
export async function releaseReservations(tx: Tx, sourceId: string, reason: 'RELEASED' | 'ORDER_CANCELLED') {
  const rows = await activeReservations(tx, sourceId);
  for (const r of rows) await tx.stockReservation.update({ where: { id: r.id }, data: { remaining: 0, closedAt: new Date(), closeReason: reason } });
  return rows.length;
}

/** Отгрузка по заказу расходует его резервы (по товару и складу отгрузки) — до отгруженного количества. */
export async function consumeForShipment(tx: Tx, doc: { docType: string; storeId: string | null; attributes: any; lines: { productId: string; qty: any }[] }) {
  const orderId = doc.attributes?.baseId;
  if (doc.docType !== 'DEMAND' || !orderId || !doc.storeId) return;
  const need = new Map<string, Dec>();
  for (const l of doc.lines) need.set(l.productId, (need.get(l.productId) ?? new D(0)).plus(l.qty));
  for (const r of await activeReservations(tx, orderId)) {
    if (r.storeId !== doc.storeId) continue;
    const n = need.get(r.productId) ?? new D(0);
    if (n.lte(0)) continue;
    const take = D.min(n, r.remaining);
    need.set(r.productId, n.minus(take));
    const left = new D(r.remaining).minus(take);
    await tx.stockReservation.update({ where: { id: r.id }, data: { remaining: left, ...(left.isZero() ? { closedAt: new Date(), closeReason: 'SHIPPED' } : {}) } });
  }
}

/**
 * Расход не забирает чужой резерв: после движений документа на складах, где товар уменьшился и есть резервы,
 * факт должен покрывать резервы (свободно ≥ 0). Без резервов — как раньше (отрицательные остатки — по политике учёта).
 */
export async function assertReservesCovered(tx: Tx, planned: PlannedMove[]) {
  const keys = new Map<string, PlannedMove>();
  for (const m of planned) if (m.qty.isNegative()) keys.set(`${m.productId}|${m.storeId}`, m);
  const bad: { productId: string; storeId: string; available: string; reserved: string }[] = [];
  for (const m of keys.values()) {
    const [row] = await tx.$queryRaw<{ qty: string; reserved: string }[]>`
      SELECT coalesce(sum(qty), 0)::text AS qty, coalesce(sum(reserved), 0)::text AS reserved FROM stock WHERE product_id = ${m.productId} AND store_id = ${m.storeId}`;
    const reserved = new D(row.reserved);
    if (reserved.gt(0) && new D(row.qty).lt(reserved)) bad.push({ productId: m.productId, storeId: m.storeId, available: D.max(new D(row.qty), 0).toString(), reserved: reserved.toString() });
  }
  if (bad.length) {
    const names = new Map((await tx.product.findMany({ where: { id: { in: bad.map((b) => b.productId) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
    const b = bad[0];
    throw new ReserveError('RESERVED_STOCK', `Товар «${names.get(b.productId) ?? b.productId}» зарезервирован под заказы: на складе ${b.available}, в резерве ${b.reserved}`, 409, bad,
      'Отгрузите по заказу (на основании), снимите резерв с заказа или уменьшите количество.');
  }
}
