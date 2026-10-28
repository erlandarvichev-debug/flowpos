import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { AccError } from '../common/acc-error';
import { D, round } from '../common/money';
import { OrgContext } from '../access/org-context';
import { PostingService } from '../core/posting.service';
import { PeriodsService, OverrideRequest, dateOnly } from '../periods/periods.service';
import { PostingInput } from '../core/posting.types';

type Tx = Prisma.TransactionClient;
type Dec = Prisma.Decimal;

interface Lot { qty: Dec; cost: Dec }
interface Move {
  id: string; sourceType: string; sourceId: string; lineNo: number; date: Date; createdAt: Date;
  productId: string; storeId: string; account: string; direction: string; kind: string;
  quantity: Dec; knownCost: Dec | null; costAccount: string | null; pairKey: string | null; meta: any;
}

export const COST_SOURCE = 'COST';
export const COST_RULE_VERSION = '1';

/**
 * Себестоимость: детерминированный пересчёт по каждому товару с начала истории.
 * Порядок: дата → приходы раньше расходов в тот же день → время записи → строка.
 * Результат пишется записями COST (источник «тип:id:товар»); повторный пересчёт без изменений
 * не создаёт новых записей (версия = хэш проводок) — закрытие воспроизводимо.
 */
@Injectable()
export class CostService {
  constructor(private posting: PostingService, private periods: PeriodsService) {}

  private async method(tx: Tx, organizationId: string, date: Date): Promise<{ method: string; allowNegative: boolean }> {
    const p = await tx.accPolicy.findFirst({ where: { organizationId, validFrom: { lte: date } }, orderBy: { validFrom: 'desc' } });
    return { method: p?.inventoryMethod ?? 'FIFO', allowNegative: !!p?.allowNegativeStock };
  }

  async recalcProducts(tx: Tx, ctx: OrgContext, productIds: string[], override?: OverrideRequest) {
    for (const productId of [...new Set(productIds)].sort()) await this.recalcProduct(tx, ctx, productId, override);
  }

  async recalcProduct(tx: Tx, ctx: OrgContext, productId: string, override?: OverrideRequest) {
    // Сериализация пересчёта по товару
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'acc-cost:' + ctx.organizationId + ':' + productId}))::text`;
    const moves = (await tx.accStockMove.findMany({
      where: { organizationId: ctx.organizationId, productId, isActive: true },
    })) as unknown as Move[];
    moves.sort((a, b) =>
      a.date.getTime() - b.date.getTime() ||
      (a.direction === b.direction ? 0 : a.direction === 'IN' ? -1 : 1) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.sourceId.localeCompare(b.sourceId) || a.lineNo - b.lineNo);

    const lots = new Map<string, Lot[]>(); // склад → партии
    const lotsOf = (store: string) => { if (!lots.has(store)) lots.set(store, []); return lots.get(store)!; };
    const qtyOf = (ls: Lot[]) => ls.reduce((a, l) => a.plus(l.qty), new D(0));
    const costOf = (ls: Lot[]) => ls.reduce((a, l) => a.plus(l.cost), new D(0));
    const pendingIn = new Map<string, Move>(); // pairKey → MOVE_IN
    for (const m of moves) if (m.kind === 'MOVE_IN' && m.pairKey) pendingIn.set(m.pairKey, m);

    // source key → postings
    const out = new Map<string, { date: Date; postings: PostingInput[]; sourceType: string; sourceId: string }>();
    const push = (m: Move, p: PostingInput[]) => {
      const key = `${m.sourceType}:${m.sourceId}:${productId}`;
      const o = out.get(key) ?? { date: m.date, postings: [], sourceType: m.sourceType, sourceId: m.sourceId };
      o.postings.push(...p);
      out.set(key, o);
    };

    const consume = async (m: Move, store: string): Promise<Dec> => {
      const ls = lotsOf(store);
      const { method, allowNegative } = await this.method(tx, ctx.organizationId, m.date);
      const have = qtyOf(ls);
      if (have.lt(m.quantity) && !allowNegative) {
        const src = m.sourceType === 'TRADE_DOCUMENT'
          ? await tx.document.findUnique({ where: { id: m.sourceId }, select: { number: true } }) : null;
        const prod = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
        const st = await tx.store.findUnique({ where: { id: store }, select: { name: true } });
        throw new AccError('NEGATIVE_STOCK',
          `Недостаточно товара «${prod?.name ?? productId}» на складе «${st?.name ?? store}» на ${dateOnly(m.date).toISOString().slice(0, 10)}: нужно ${m.quantity.toFixed(3)}, есть ${have.toFixed(3)}${src?.number ? ` (документ ${src.number})` : ''}`,
          { fix: 'Проведите поступление раньше этой даты, уменьшите количество или разрешите отрицательные остатки в учётной политике.', details: { productId, storeId: store, date: m.date } });
      }
      let need = m.quantity;
      let cost = new D(0);
      if (method === 'AVERAGE') {
        const q = qtyOf(ls), c = costOf(ls);
        const unit = q.gt(0) ? c.div(q) : new D(0);
        cost = round(unit.times(D.min(need, q.gt(0) ? q : new D(0))));
        const remainingQty = q.minus(need);
        const remainingCost = c.minus(cost);
        ls.length = 0;
        if (!remainingQty.isZero()) ls.push({ qty: remainingQty, cost: remainingQty.gt(0) ? remainingCost : new D(0) });
        return cost;
      }
      while (need.gt(0) && ls.length && ls[0].qty.gt(0)) {
        const lot = ls[0];
        if (lot.qty.lte(need)) {
          cost = cost.plus(lot.cost); need = need.minus(lot.qty); ls.shift();
        } else {
          const part = round(lot.cost.times(need).div(lot.qty));
          cost = cost.plus(part); lot.cost = lot.cost.minus(part); lot.qty = lot.qty.minus(need); need = new D(0);
        }
      }
      if (need.gt(0)) ls.push({ qty: need.neg(), cost: new D(0) }); // разрешённый минус: стоимость 0, учтётся при приходе
      return cost;
    };

    const addLot = (store: string, qty: Dec, cost: Dec) => {
      const ls = lotsOf(store);
      // погашение разрешённого минуса
      if (ls.length && ls[ls.length - 1].qty.isNegative()) {
        ls[ls.length - 1].qty = ls[ls.length - 1].qty.plus(qty);
        ls[ls.length - 1].cost = ls[ls.length - 1].cost.plus(cost);
        if (ls[ls.length - 1].qty.isZero()) ls.pop();
        return;
      }
      ls.push({ qty, cost });
    };

    const inv = (m: Move, side: 'D' | 'C', amount: Dec, qty: Dec, store: string): PostingInput =>
      ({ side, account: m.account, amount: amount.toFixed(2), quantity: qty.toFixed(3), dims: { PRODUCT: productId, STORE: store }, memo: 'Себестоимость' });

    for (const m of moves) {
      if (m.kind === 'MOVE_IN') continue; // обрабатывается вместе с MOVE_OUT
      if (m.direction === 'IN') {
        let cost = m.knownCost;
        if (cost === null) {
          // возврат от покупателя: по средней текущей себестоимости склада
          const ls = lotsOf(m.storeId);
          const q = qtyOf(ls), c = costOf(ls);
          cost = q.gt(0) ? round(c.div(q).times(m.quantity)) : new D(m.meta?.fallbackCost ?? 0);
          if (!cost.isZero()) push(m, [inv(m, 'D', cost, m.quantity, m.storeId), { side: 'C', account: m.costAccount ?? '7010', amount: cost.toFixed(2), dims: { PRODUCT: productId }, memo: 'Возврат себестоимости' }]);
        }
        addLot(m.storeId, m.quantity, cost);
        continue;
      }
      const cost = await consume(m, m.storeId);
      if (m.kind === 'MOVE_OUT') {
        const pin = m.pairKey ? pendingIn.get(m.pairKey) : undefined;
        if (!pin) throw new AccError('MOVE_PAIR_MISSING', 'Перемещение без прихода на склад-получатель');
        addLot(pin.storeId, pin.quantity, cost);
        if (!cost.isZero()) push(m, [inv(pin, 'D', cost, pin.quantity, pin.storeId), inv(m, 'C', cost, m.quantity, m.storeId)]);
        continue;
      }
      if (m.knownCost !== null) {
        // возврат поставщику: учётная цена известна, разница с себестоимостью партии — в прочие доходы/расходы
        const diff = m.knownCost.minus(cost);
        if (!diff.isZero()) {
          push(m, diff.isPositive()
            ? [{ side: 'D', account: m.account, amount: diff.toFixed(2), dims: { PRODUCT: productId, STORE: m.storeId }, memo: 'Разница стоимости возврата' }, { side: 'C', account: '6190', amount: diff.toFixed(2), memo: 'Разница стоимости возврата' }]
            : [{ side: 'D', account: '7170', amount: diff.neg().toFixed(2), memo: 'Разница стоимости возврата' }, { side: 'C', account: m.account, amount: diff.neg().toFixed(2), dims: { PRODUCT: productId, STORE: m.storeId }, memo: 'Разница стоимости возврата' }]);
        }
        continue;
      }
      // продажа / списание: Дт счёт затрат — Кт запасы (с количеством)
      const costAcc = m.costAccount ?? '7010';
      const dims: any = costAcc === '7010' ? { PRODUCT: productId } : {};
      if (m.meta?.departmentId && costAcc !== '7010') dims.DEPARTMENT = m.meta.departmentId;
      if (cost.isZero()) {
        // нулевая себестоимость: количество всё равно списываем отдельной строкой нельзя (сумма 0 запрещена) — фиксируем в мета
        continue;
      }
      push(m, [{ side: 'D', account: costAcc, amount: cost.toFixed(2), dims, memo: 'Себестоимость' }, inv(m, 'C', cost, m.quantity, m.storeId)]);
    }

    // Запись результата: только изменившиеся источники; исчезнувшие — отменить
    const existing = await tx.accEntry.findMany({
      where: { organizationId: ctx.organizationId, sourceType: COST_SOURCE, status: 'ACTIVE', sourceId: { endsWith: `:${productId}` } },
    });
    const keep = new Set<string>();
    for (const [key, o] of out) {
      keep.add(key);
      const version = this.versionOf(o.postings);
      const cur = existing.find((e) => e.sourceId === key);
      if (cur && cur.sourceVersion === version) continue;
      await this.periods.assertOpen(tx, ctx, [o.date, ...(cur ? [cur.date] : [])], override, 'пересчёт себестоимости');
      await this.posting.writeEntry(tx, ctx, {
        sourceType: COST_SOURCE, sourceId: key, sourceVersion: version, ruleCode: 'COST', ruleVersion: COST_RULE_VERSION,
        date: o.date, postings: o.postings,
      });
    }
    for (const e of existing) {
      if (keep.has(e.sourceId)) continue;
      await this.periods.assertOpen(tx, ctx, [e.date], override, 'пересчёт себестоимости');
      await this.posting.cancelSource(tx, ctx.organizationId, COST_SOURCE, e.sourceId);
    }
  }

  private versionOf(postings: PostingInput[]): number {
    const h = createHash('sha1').update(JSON.stringify(postings)).digest();
    return h.readInt32BE(0);
  }
}
