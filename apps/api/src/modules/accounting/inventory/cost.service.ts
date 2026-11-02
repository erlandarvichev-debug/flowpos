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

/** Партия: количество, стоимость и ссылка на строку поступления (документ:строка) — для доп. расходов (FP-031). */
interface Lot { qty: Dec; cost: Dec; ref: string | null }
interface Move {
  id: string; sourceType: string; sourceId: string; lineNo: number; date: Date; createdAt: Date;
  productId: string; storeId: string; account: string; direction: string; kind: string;
  quantity: Dec; knownCost: Dec | null; costAccount: string | null; pairKey: string | null; meta: any;
}

export const COST_SOURCE = 'COST';
export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
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

  /**
   * FP-031: метод оценки — метод периода (месяца): учётная политика, действующая на 1-е число месяца движения.
   * Внутри месяца метод не меняется, даже если версия политики начата с середины месяца (она действует со следующего).
   */
  private async method(tx: Tx, organizationId: string, date: Date): Promise<{ method: string; allowNegative: boolean }> {
    const p = await tx.accPolicy.findFirst({ where: { organizationId, validFrom: { lte: monthStart(date) } }, orderBy: { validFrom: 'desc' } });
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

    /** Расход: стоимость и списанные куски партий (со ссылками на поступление — для перемещения). */
    const consume = async (m: Move, store: string): Promise<{ cost: Dec; pieces: Lot[] }> => {
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
      const pieces: Lot[] = [];
      if (method === 'AVERAGE') {
        const q = qtyOf(ls), c = costOf(ls);
        // Весь остаток уходит целиком — по его полной стоимости (без потери тиынов на округлении средней).
        const taken = q.gt(0) ? D.min(need, q) : new D(0);
        cost = taken.isZero() ? new D(0) : taken.eq(q) ? c : round(c.div(q).times(taken));
        if (taken.gt(0)) pieces.push({ qty: taken, cost, ref: null });
        const remainingQty = q.minus(need);
        const remainingCost = c.minus(cost);
        ls.length = 0;
        if (!remainingQty.isZero()) ls.push({ qty: remainingQty, cost: remainingQty.gt(0) ? remainingCost : new D(0), ref: null });
        if (need.gt(taken)) pieces.push({ qty: need.minus(taken), cost: new D(0), ref: null });
        return { cost, pieces };
      }
      while (need.gt(0) && ls.length && ls[0].qty.gt(0)) {
        const lot = ls[0];
        if (lot.qty.lte(need)) {
          cost = cost.plus(lot.cost); need = need.minus(lot.qty); pieces.push({ ...lot }); ls.shift();
        } else {
          const part = round(lot.cost.times(need).div(lot.qty));
          cost = cost.plus(part); pieces.push({ qty: need, cost: part, ref: lot.ref }); lot.cost = lot.cost.minus(part); lot.qty = lot.qty.minus(need); need = new D(0);
        }
      }
      if (need.gt(0)) {
        ls.push({ qty: need.neg(), cost: new D(0), ref: null }); // разрешённый минус: стоимость 0, учтётся при приходе
        pieces.push({ qty: need, cost: new D(0), ref: null });
      }
      return { cost, pieces };
    };

    const addLot = (store: string, qty: Dec, cost: Dec, ref: string | null) => {
      const ls = lotsOf(store);
      // погашение разрешённого минуса
      if (ls.length && ls[ls.length - 1].qty.isNegative()) {
        const last = ls[ls.length - 1];
        last.qty = last.qty.plus(qty);
        last.cost = last.cost.plus(cost);
        if (last.qty.gt(0)) last.ref = ref;
        if (last.qty.isZero()) ls.pop();
        return;
      }
      ls.push({ qty, cost, ref });
    };
    const valuePosting = (side: 'D' | 'C', account: string, amount: Dec, store: string, memo: string): PostingInput =>
      ({ side, account, amount: amount.toFixed(2), quantity: '0.000', dims: { PRODUCT: productId, STORE: store }, memo }); // только стоимость

    const inv = (m: Move, side: 'D' | 'C', amount: Dec, qty: Dec, store: string): PostingInput =>
      ({ side, account: m.account, amount: amount.toFixed(2), quantity: qty.toFixed(3), dims: { PRODUCT: productId, STORE: store }, memo: 'Себестоимость' });

    // FP-034: себестоимость расходов (продаж) по документу и товару — для возврата на основании.
    const issued = new Map<string, { qty: Dec; cost: Dec }>();
    for (const m of moves) {
      if (m.kind === 'MOVE_IN') continue; // обрабатывается вместе с MOVE_OUT
      if (m.kind === 'LANDED_COST') {
        await this.applyLanded(tx, ctx.organizationId, m, moves, lots, productId, push, valuePosting);
        continue;
      }
      if (m.direction === 'IN') {
        let cost = m.knownCost;
        if (cost === null) {
          // возврат от покупателя: на основании — по себестоимости единицы исходной отгрузки; иначе — по средней склада
          const ls = lotsOf(m.storeId);
          const q = qtyOf(ls), c = costOf(ls);
          const base = m.meta?.baseSourceId ? issued.get(`${m.meta.baseSourceId}:${productId}`) : undefined;
          cost = base && base.qty.gt(0) ? round(base.cost.div(base.qty).times(m.quantity))
            : q.gt(0) ? round(c.div(q).times(m.quantity)) : new D(m.meta?.fallbackCost ?? 0);
          if (!cost.isZero()) push(m, [inv(m, 'D', cost, m.quantity, m.storeId), { side: 'C', account: m.costAccount ?? '7010', amount: cost.toFixed(2), dims: { PRODUCT: productId }, memo: 'Возврат себестоимости' }]);
        }
        addLot(m.storeId, m.quantity, cost, ['PURCHASE', 'ENTER', 'OPENING', 'INVENTORY_SURPLUS'].includes(m.kind) ? `${m.sourceId}:${m.lineNo}` : null);
        continue;
      }
      const { cost, pieces } = await consume(m, m.storeId);
      if (m.kind === 'MOVE_OUT') {
        const pin = m.pairKey ? pendingIn.get(m.pairKey) : undefined;
        if (!pin) throw new AccError('MOVE_PAIR_MISSING', 'Перемещение без прихода на склад-получатель');
        // Куски партий переезжают со ссылками на поступление (доп. расходы найдут их и на другом складе).
        for (const p of pieces) addLot(pin.storeId, p.qty, p.cost, p.ref);
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
      if (m.kind === 'SALE') {
        const k = `${m.sourceId}:${productId}`;
        const prev = issued.get(k) ?? { qty: new D(0), cost: new D(0) };
        issued.set(k, { qty: prev.qty.plus(m.quantity), cost: prev.cost.plus(cost) });
      }
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

  /**
   * FP-031: доп. расходы на строку поступления (ref = документ:строка, сумма A). Q0 — количество строки поступления,
   * H — сколько из него ещё в партиях (на любых складах). FIFO: на остаток — round(A × H / Q0), по партиям
   * пропорционально количеству (остаток округления — последней партии в порядке складов и очереди), остальное — уже
   * списано: в себестоимость (счёт затрат строки, по умолчанию 7010) на дату доп. расходов. Часть на другом складе —
   * переносом стоимости со склада поступления. Средняя: идентичность партий потеряна — доля
   * round(A × min(остаток склада поступления, Q0) / Q0) в стоимость остатка склада, остальное — в себестоимость.
   */
  private async applyLanded(
    tx: Tx, organizationId: string, m: Move, moves: Move[], lots: Map<string, Lot[]>, productId: string,
    push: (m: Move, p: PostingInput[]) => void,
    valuePosting: (side: 'D' | 'C', account: string, amount: Dec, store: string, memo: string) => PostingInput,
  ) {
    const ref = m.pairKey!;
    const A = new D(m.knownCost ?? 0);
    const base = moves.find((x) => x.direction === 'IN' && x.kind === 'PURCHASE' && `${x.sourceId}:${x.lineNo}` === ref);
    if (!base || base.date.getTime() > m.date.getTime()) {
      throw new AccError('LANDED_BASE_MISSING', 'Доп. расходы относятся к строке поступления, которой нет (поступление снято с проведения или изменено)', { fix: 'Снимите с проведения доп. расходы или верните поступление.' });
    }
    const Q0 = base.quantity;
    const baseStore = base.storeId;
    const { method } = await this.method(tx, organizationId, m.date);
    const cogs = m.costAccount ?? '7010';
    const memo = 'Доп. расходы';
    let onHand = new D(0);
    if (method === 'AVERAGE') {
      const ls = lots.get(baseStore) ?? [];
      const q = ls.reduce((a, l) => a.plus(l.qty), new D(0));
      const share = q.gt(0) ? (q.gte(Q0) ? A : round(A.times(q).div(Q0))) : new D(0);
      if (share.gt(0) && ls.length) { ls[0].cost = ls[0].cost.plus(share); onHand = share; }
    } else {
      const held: { store: string; lot: Lot }[] = [];
      for (const store of [...lots.keys()].sort()) for (const lot of lots.get(store)!) if (lot.ref === ref && lot.qty.gt(0)) held.push({ store, lot });
      const H = held.reduce((a, h) => a.plus(h.lot.qty), new D(0));
      const share = H.gte(Q0) ? A : round(A.times(H).div(Q0));
      let left = share;
      held.forEach((h, i) => {
        const part = i === held.length - 1 ? left : round(share.times(h.lot.qty).div(H));
        left = left.minus(part);
        h.lot.cost = h.lot.cost.plus(part);
        if (h.store !== baseStore && !part.isZero()) push(m, [valuePosting('D', m.account, part, h.store, memo), valuePosting('C', m.account, part, baseStore, memo)]);
      });
      onHand = share;
    }
    const sold = A.minus(onHand);
    if (!sold.isZero()) push(m, [{ side: 'D', account: cogs, amount: sold.toFixed(2), dims: cogs === '7010' ? { PRODUCT: productId } : {}, memo: `${memo}: доля списанного товара` }, valuePosting('C', m.account, sold, baseStore, `${memo}: доля списанного товара`)]);
  }

  private versionOf(postings: PostingInput[]): number {
    const h = createHash('sha1').update(JSON.stringify(postings)).digest();
    return h.readInt32BE(0);
  }
}
