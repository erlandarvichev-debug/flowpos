// FP-039: пакет налоговых правил (публикация, утверждение с оговорками, неизменность) и регистр НДС за квартал
// (по ставкам, сверка с учётом, зачёт FP-019, фиксация, воспроизводимость). Эталон — test/golden/vat-2026-q2.json.
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaxService } from '../src/modules/accounting/tax/tax.service';
import { KZ_2026_1, packHash } from '../src/modules/accounting/tax/rule-packs';
import { makeOrg, makeServices, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const tax = new TaxService(prisma, s.autopilot);
const golden = JSON.parse(readFileSync(join(__dirname, 'golden/vat-2026-q2.json'), 'utf8'));
const ALL_KEYS = KZ_2026_1.unverified.map((u) => u.key);

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? (/\b([A-Z_]{5,}): /.exec(String(e?.message))?.[1]) ?? e?.message; }
}
afterAll(() => prisma.$disconnect());

async function adopted() {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer: true });
  const pack = (await tax.packs(ctx)).find((p) => p.code === 'KZ' && p.version === '2026.1')!;
  await tax.adopt(ctx, pack.id, { acknowledged: ALL_KEYS });
  return { ctx, t, pack };
}

describe('FP-039: пакет налоговых правил', () => {
  it('публикуется из кода с хэшем; утверждение требует подтвердить каждый неподтверждённый пункт; содержимое неизменно', async () => {
    const ctx = await makeOrg(prisma);
    const pack = (await tax.packs(ctx)).find((p) => p.code === 'KZ' && p.version === '2026.1')!;
    expect(pack.contentHash).toBe(packHash(KZ_2026_1));
    expect((pack.params as any).vat.standardRate).toBe(16);
    expect(pack.adoption).toBeNull();
    // Без утверждения — налоговые расчёты не выполняются.
    await makeTrade(prisma, ctx);
    expect(await code(tax.buildVat(ctx, 2026, 'Q2'))).toBe('TAX_PACK_NOT_APPROVED');
    expect(await code(tax.adopt(ctx, pack.id, { acknowledged: ALL_KEYS.slice(1) }))).toBe('TAX_PACK_ACK_REQUIRED');
    const a = await tax.adopt(ctx, pack.id, { acknowledged: ALL_KEYS });
    expect([a.approvedBy, a.contentHash]).toEqual([ctx.userId, pack.contentHash]);
    expect(await code(tax.adopt(ctx, pack.id, { acknowledged: ALL_KEYS }))).toBe('TAX_PACK_ALREADY_APPROVED');
    expect(await prisma.auditLog.count({ where: { organizationId: ctx.organizationId, action: 'TAX_PACK_APPROVED' } })).toBe(1);
    // БД: пакет и утверждение не меняются; отзыв — только с причиной.
    // Неизменность проверяется на одноразовом пакете — не на общем (он нужен всем организациям).
    const tmp = await prisma.taxRulePack.create({ data: { code: 'TEST', version: randomUUID(), validFrom: new Date('2026-01-01'), params: { vat: { standardRate: 16 } }, sources: [], unverified: [], contentHash: 'h' } });
    expect(await code(prisma.taxRulePack.update({ where: { id: tmp.id }, data: { params: { vat: { standardRate: 12 } } } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.taxRulePack.update({ where: { id: tmp.id }, data: { validTo: new Date('2026-06-30') } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.taxRulePack.delete({ where: { id: tmp.id } }))).toBe('ACC_IMMUTABLE');
    expect((await prisma.taxRulePack.update({ where: { id: tmp.id }, data: { status: 'RETIRED' } })).status).toBe('RETIRED');
    expect(await code(prisma.taxRulePack.update({ where: { id: tmp.id }, data: { status: 'PUBLISHED' } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.orgTaxPack.update({ where: { id: a.id }, data: { status: 'REVOKED', revokedBy: ctx.userId, revokedAt: new Date() } }))).toBe('ACC_IMMUTABLE');
    expect(await code(tax.revoke(ctx, a.id, 'нет'))).toBe('REASON_REQUIRED');
    await tax.revoke(ctx, a.id, 'Сверили со ст. 503 — ждём новую версию');
    expect(await code(tax.buildVat(ctx, 2026, 'Q2'))).toBe('TAX_PACK_NOT_APPROVED');
  });
});

describe('FP-039: регистр НДС', () => {
  async function quarter() {
    const { ctx, t } = await adopted();
    const reduced = await prisma.product.create({ data: { name: `Лекарство ${randomUUID().slice(0, 6)}`, uomId: t.uom.id, organizationId: ctx.organizationId, vatRate: 5 } });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-04-02', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '100', price: '116' }, { productId: reduced.id, qty: '10', price: '105' }] });
    const sale1 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-04-10', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '232' }] });
    const sale2 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-05-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: reduced.id, qty: '3', price: '105' }, { productId: t.service.id, qty: '1', price: '1160' }] });
    const ret1 = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-05-20', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale1.id, lines: [{ productId: t.goods.id, qty: '2', price: '232' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-07-01', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '232' }] });
    // Зачёт по ЭСФ поставщика (регистр FP-019) — II квартал.
    const esf = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', num: `IN-${randomUUID().slice(0, 6)}`, date: new Date('2026-04-02'), turnoverDate: new Date('2026-04-02'), body: '<x/>', bodyHash: 'h', sellerTin: t.supplier.inn, sellerName: 'ТОО Поставщик', totalNds: 1600, status: 'DELIVERED' } });
    await prisma.vatCreditAllocation.create({ data: { organizationId: ctx.organizationId, esfInvoiceId: esf.id, kind: 'CREDIT', year: 2026, quarter: 2, amount: 1600, method: 'FULL', ruleCode: 'KZ_VAT_INPUT_CREDIT', ruleVersion: '1.0.0-draft', basis: 'тест', esfSnapshot: 'h', createdBy: ctx.userId } });
    const esf2 = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', num: `IN-${randomUUID().slice(0, 6)}`, date: new Date('2026-05-02'), turnoverDate: new Date('2026-05-02'), body: '<y/>', bodyHash: 'h2', totalNds: 50, status: 'DELIVERED' } });
    await prisma.vatCreditAllocation.create({ data: { organizationId: ctx.organizationId, esfInvoiceId: esf2.id, kind: 'NON_CREDITABLE', year: 2026, quarter: 2, amount: 50, method: 'FULL', ruleCode: 'KZ_VAT_INPUT_CREDIT', ruleVersion: '1.0.0-draft', basis: 'тест', esfSnapshot: 'h2', createdBy: ctx.userId } });
    return { ctx, t, ids: { sale1: sale1.id, sale2: sale2.id, ret1: ret1.id } as Record<string, string> };
  }

  it('эталон: обороты по ставкам, возврат с минусом, другой квартал не входит, зачёт, к уплате; сверка с учётом', async () => {
    const { ctx, ids } = await quarter();
    const reg = await tax.buildVat(ctx, 2026, 'Q2');
    const d = reg.data as any;
    expect(d.output.byRate).toEqual(golden.output.byRate);
    expect(d.output.vat).toBe(golden.output.vat);
    expect(d.output.rows.map((r: any) => [r.docId, r.vat, r.ledgerVat])).toEqual(golden.output.docs.map((g: any) => [ids[g.key], g.vat, g.vat]));
    expect([d.input.credit, d.input.nonCreditable]).toEqual([golden.input.credit, golden.input.nonCreditable]);
    expect(d.payable).toBe(golden.payable);
    expect(d.issues.filter((i: any) => i.severity === 'ERROR')).toEqual([]);
    expect([reg.status, reg.packVersion]).toEqual(['DRAFT', 'KZ 2026.1']);
  });

  it('фиксация, воспроизводимость, изменение после фиксации видно; повторная фиксация — с причиной; ошибки не фиксируются', async () => {
    const { ctx, t, ids } = await quarter();
    const draft = await tax.buildVat(ctx, 2026, 'Q2');
    const fixed = await tax.fix(ctx, draft.id, {});
    expect(fixed.status).toBe('FIXED');
    expect(await tax.verify(ctx, fixed.id)).toMatchObject({ same: true, changedDocs: [] });
    expect(await code(prisma.taxRegister.update({ where: { id: fixed.id }, data: { data: {} } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.taxRegister.delete({ where: { id: fixed.id } }))).toBe('ACC_IMMUTABLE');

    // Ещё одна реализация во II квартале — зафиксированный регистр больше не совпадает с учётом.
    const late = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-06-30', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '232' }] });
    const v = await tax.verify(ctx, fixed.id);
    expect(v).toMatchObject({ same: false, was: { outputVat: '431.00' }, now: { outputVat: '463.00' }, changedDocs: [late.id] });

    // Черновик устарел, если данные изменились после сборки.
    const draft2 = await tax.buildVat(ctx, 2026, 'Q2');
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-06-30', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '232' }] });
    expect(await code(tax.fix(ctx, draft2.id, { reason: 'Поздняя реализация' }))).toBe('REGISTER_STALE');
    const draft3 = await tax.buildVat(ctx, 2026, 'Q2');
    expect(await code(tax.fix(ctx, draft3.id, {}))).toBe('REASON_REQUIRED');
    const fixed2 = await tax.fix(ctx, draft3.id, { reason: 'Поздние реализации 30.06' });
    expect((await prisma.taxRegister.findUniqueOrThrow({ where: { id: fixed.id } }))).toMatchObject({ status: 'SUPERSEDED', supersededBy: fixed2.id, supersedeReason: 'Поздние реализации 30.06' });

    // Документ проведён, но не отражён в учёте (автопилот ещё не прошёл / сбой) — ошибка регистра, фиксировать нельзя.
    const raw = await prisma.document.create({ data: { docType: 'DEMAND', status: 'POSTED', date: new Date('2026-06-15'), organizationId: ctx.organizationId, storeId: t.s1.id, counterpartyId: t.customer.id, number: `RAW-${randomUUID().slice(0, 4)}`, total: 232, lines: { create: [{ lineNo: 1, productId: t.goods.id, qty: 1, price: 232, amount: 232 }] } } });
    const broken = await tax.buildVat(ctx, 2026, 'Q2');
    expect((broken.data as any).issues.filter((i: any) => i.severity === 'ERROR').map((i: any) => [i.code, i.docId])).toEqual([['DOC_NOT_REFLECTED', raw.id]]);
    expect(await code(tax.fix(ctx, broken.id, { reason: 'Проверка ошибок' }))).toBe('REGISTER_HAS_ERRORS');
  });

  it('НДС в учёте разошёлся с документом — ошибка регистра с указанием документа', async () => {
    const { ctx, t, ids } = await quarter();
    // Как будто правило проводок посчитало НДС иначе: проводки документа заменены (300 вместо 320).
    await prisma.$transaction((tx) => s.posting.writeEntry(tx, ctx, { sourceType: 'TRADE_DOCUMENT', sourceId: ids.sale1, sourceVersion: 99, ruleCode: 'TEST', ruleVersion: 'x', date: new Date('2026-04-10'),
      postings: [{ side: 'D', account: '1210', amount: '2300.00', dims: { COUNTERPARTY: t.customer.id, SETTLEMENT_DOC: ids.sale1 } }, { side: 'C', account: '6010', amount: '2000.00' }, { side: 'C', account: '3130', amount: '300.00', dims: { COUNTERPARTY: t.customer.id } }] } as any));
    const d = (await tax.buildVat(ctx, 2026, 'Q2')).data as any;
    expect(d.issues.filter((i: any) => i.severity === 'ERROR').map((i: any) => [i.code, i.docId])).toEqual([['LEDGER_MISMATCH', ids.sale1]]);
    expect(d.output.rows.find((r: any) => r.docId === ids.sale1)).toMatchObject({ vat: '320.00', ledgerVat: '300.00' });
  });

  it('не плательщик НДС — регистр не ведётся; неверный период', async () => {
    const { ctx } = await adopted();
    expect(await code(tax.buildVat(ctx, 2026, 'Q5'))).toBe('BAD_PERIOD');
    await prisma.accPolicy.updateMany({ where: { organizationId: ctx.organizationId }, data: { vatPayer: false } });
    expect(await code(tax.buildVat(ctx, 2026, 'Q2'))).toBe('NOT_VAT_PAYER');
  });
});
