// FP-054: декларации 300.00 и 910.00 (приказ МФ № 695) из зафиксированных регистров — эталоны посчитаны вручную;
// контрольные соотношения, неизменность готовой декларации, сдача с номером, дополнительная, устаревший регистр.
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaxService } from '../src/modules/accounting/tax/tax.service';
import { DeclarationsService } from '../src/modules/accounting/tax/declarations.service';
import { KZ_2026_1 } from '../src/modules/accounting/tax/rule-packs';
import { declarationPdf, declarationXlsx, headerRows } from '../src/modules/accounting/tax/declaration-export';
import * as ExcelJS from 'exceljs';
import { makeOrg, makeServices, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const tax = new TaxService(prisma, s.autopilot);
const decl = new DeclarationsService(prisma, tax);
const g300 = JSON.parse(readFileSync(join(__dirname, 'golden/fno-300-2026-q2.json'), 'utf8'));
const g910 = JSON.parse(readFileSync(join(__dirname, 'golden/fno-910-2026-h1.json'), 'utf8'));
const ALL = KZ_2026_1.unverified.map((u) => u.key);

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? (/\b([A-Z_]{5,}): /.exec(String(e?.message))?.[1]) ?? e?.message; }
}
const lines = (d: any) => Object.fromEntries((d.lines as any[]).map((l) => [l.code, l.value]));
afterAll(() => prisma.$disconnect());

async function org(opts: { vatPayer: boolean; regime?: string }) {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer: opts.vatPayer });
  if (opts.regime) await prisma.accPolicy.updateMany({ where: { organizationId: ctx.organizationId }, data: { taxRegime: opts.regime } });
  const pack = (await tax.packs(ctx)).find((p) => p.code === 'KZ' && p.version === '2026.1')!;
  await tax.adopt(ctx, pack.id, { acknowledged: ALL });
  return { ctx, t };
}

describe('FP-054: 300.00', () => {
  async function q2() {
    const { ctx, t } = await org({ vatPayer: true });
    const reduced = await prisma.product.create({ data: { name: `Лекарство ${randomUUID().slice(0, 6)}`, uomId: t.uom.id, organizationId: ctx.organizationId, vatRate: 5 } });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-04-02', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '100', price: '116' }, { productId: reduced.id, qty: '10', price: '105' }] });
    const sale1 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-04-10', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '232' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-05-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: reduced.id, qty: '3', price: '105' }, { productId: t.service.id, qty: '1', price: '1160' }] });
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-05-20', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale1.id, lines: [{ productId: t.goods.id, qty: '2', price: '232' }] });
    const esf = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', num: `IN-${randomUUID().slice(0, 6)}`, date: new Date('2026-04-02'), turnoverDate: new Date('2026-04-02'), body: '<x/>', bodyHash: 'h', totalWithoutTax: 10000, totalNds: 1600, status: 'DELIVERED' } });
    await prisma.vatCreditAllocation.create({ data: { organizationId: ctx.organizationId, esfInvoiceId: esf.id, kind: 'CREDIT', year: 2026, quarter: 2, amount: 1600, method: 'FULL', ruleCode: 'KZ_VAT_INPUT_CREDIT', ruleVersion: '1.0.0-draft', basis: 'тест', esfSnapshot: 'h', createdBy: ctx.userId } });
    const esf2 = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', num: `IN-${randomUUID().slice(0, 6)}`, date: new Date('2026-05-02'), turnoverDate: new Date('2026-05-02'), body: '<y/>', bodyHash: 'h2', totalWithoutTax: 312.5, totalNds: 50, status: 'DELIVERED' } });
    await prisma.vatCreditAllocation.create({ data: { organizationId: ctx.organizationId, esfInvoiceId: esf2.id, kind: 'NON_CREDITABLE', year: 2026, quarter: 2, amount: 50, method: 'FULL', ruleCode: 'KZ_VAT_INPUT_CREDIT', ruleVersion: '1.0.0-draft', basis: 'тест', esfSnapshot: 'h2', createdBy: ctx.userId } });
    const esf3 = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', num: `IN-${randomUUID().slice(0, 6)}`, date: new Date('2026-06-02'), turnoverDate: new Date('2026-06-02'), body: '<z/>', bodyHash: 'h3', totalWithoutTax: 1000, totalNds: 160, status: 'DELIVERED' } });
    await prisma.vatCreditAllocation.create({ data: { organizationId: ctx.organizationId, esfInvoiceId: esf3.id, kind: 'CREDIT', year: 2026, quarter: 2, amount: 80, method: 'PROPORTIONAL', ruleCode: 'KZ_VAT_INPUT_CREDIT', ruleVersion: '1.0.0-draft', basis: 'тест', esfSnapshot: 'h3', createdBy: ctx.userId } });
    return { ctx, t };
  }

  it('эталон строк; контрольные соотношения выполнены; только из зафиксированного регистра', async () => {
    const { ctx } = await q2();
    expect(await code(decl.build(ctx, { form: '300.00', year: 2026, period: 'Q2' }))).toBe('REGISTER_NOT_FIXED');
    const reg = await tax.buildVat(ctx, 2026, 'Q2');
    expect(await code(decl.build(ctx, { form: '300.00', year: 2026, period: 'Q2' }))).toBe('REGISTER_NOT_FIXED'); // черновик регистра — не основание
    await tax.fix(ctx, reg.id, {});
    const d = await decl.build(ctx, { form: '300.00', year: 2026, period: 'Q2' });
    const got = lines(d);
    for (const [k, v] of Object.entries(g300.lines)) expect([k, got[k]]).toEqual([k, v]);
    expect((d.checks as any[]).filter((c) => !c.ok && c.severity === 'ERROR')).toEqual([]);
    expect(d.header).toMatchObject({ form: '300.00', year: 2026, period: 'Q2', kind: 'INITIAL', vatCreditMethod: 'PROPORTIONAL' });
    // Печатная форма: PDF и Excel с шапкой и всеми строками (значения те же).
    const pdf = await declarationPdf(d as any);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(headerRows(d as any)).toEqual(expect.arrayContaining([['Налоговый период', '2 квартал 2026 года'], ['Вид декларации', 'первоначальная']]));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await declarationXlsx(d as any) as any);
    const cells = new Map<string, number>();
    wb.worksheets[0].eachRow((r) => { const c = r.getCell(1).value, v = r.getCell(3).value; if (typeof c === 'string' && typeof v === 'number') cells.set(c, v); });
    expect(cells.get('300.00.030 II')).toBe(Number(g300.lines['300.00.030 II']));
    expect(cells.size).toBe((d.lines as any[]).length);
  });

  it('готова → неизменна; сдача с номером; первоначальная повторно — нельзя, дополнительная — можно; регистр изменился — не собирается', async () => {
    const { ctx, t } = await q2();
    const reg = await tax.buildVat(ctx, 2026, 'Q2');
    await tax.fix(ctx, reg.id, {});
    const d = await decl.build(ctx, { form: '300.00', year: 2026, period: 'Q2' });
    const fin = await decl.finalize(ctx, d.id);
    expect(fin.status).toBe('FINAL');
    expect(await code(prisma.taxDeclaration.update({ where: { id: d.id }, data: { lines: [] } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.taxDeclaration.delete({ where: { id: d.id } }))).toBe('ACC_IMMUTABLE');
    expect(await code(decl.mark(ctx, d.id, { status: 'ACCEPTED' }))).toBe('BAD_STATUS');
    expect(await code(decl.mark(ctx, d.id, { status: 'SUBMITTED' }))).toBe('RECEIPT_REQUIRED');
    const sub = await decl.mark(ctx, d.id, { status: 'SUBMITTED', number: '6200000012345678', date: '2026-08-10' });
    expect([sub.status, (sub.receipt as any).number]).toEqual(['SUBMITTED', '6200000012345678']);
    expect(await code(decl.mark(ctx, d.id, { status: 'REJECTED', note: 'нет' }))).toBe('REASON_REQUIRED');
    expect((await decl.mark(ctx, d.id, { status: 'ACCEPTED' })).status).toBe('ACCEPTED');
    expect(await code(decl.build(ctx, { form: '300.00', year: 2026, period: 'Q2' }))).toBe('DECLARATION_EXISTS');

    // Поздняя реализация: зафиксированный регистр устарел — декларация не собирается, пока регистр не пересобран.
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-06-30', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '232' }] });
    expect(await code(decl.build(ctx, { form: '300.00', year: 2026, period: 'Q2', kind: 'ADDITIONAL' }))).toBe('REGISTER_OUTDATED');
    const reg2 = await tax.buildVat(ctx, 2026, 'Q2');
    await tax.fix(ctx, reg2.id, { reason: 'Поздняя реализация 30.06' });
    const add = await decl.build(ctx, { form: '300.00', year: 2026, period: 'Q2', kind: 'ADDITIONAL' });
    expect([add.kind, add.previousId, lines(add)['300.00.012'], lines(add)['300.00.030 II']]).toEqual(['ADDITIONAL', d.id, '463.00', '1217.00']);
  });
});

describe('FP-054: 910.00', () => {
  async function h1() {
    const { ctx, t } = await org({ vatPayer: false, regime: 'SIMPLIFIED' });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-01-15', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '400' }] });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-02-10', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3', price: '1000' }] });
    await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-03-01', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale.id, lines: [{ productId: t.goods.id, qty: '0.5', price: '1000' }] });
    await s.trade.create(ctx, { docType: 'ENTER', date: '2026-04-01', storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '200' }] });
    await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-07-01', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '1000' }] });
    return { ctx, t };
  }

  it('эталон: доход за полугодие, ставка 4% и ставка маслихата; исключение счёта из дохода; не упрощёнка — нельзя', async () => {
    const { ctx } = await h1();
    const reg = await tax.buildSimplified(ctx, 2026, 'H1');
    expect((reg.data as any).income).toBe(g910.income);
    await tax.fix(ctx, reg.id, {});
    const d = await decl.build(ctx, { form: '910.00', year: 2026, period: 'H1' });
    const got = lines(d);
    for (const [k, v] of Object.entries(g910.lines)) expect([k, got[k]]).toEqual([k, v]);
    expect((d.checks as any[]).filter((c) => !c.ok && c.severity === 'ERROR')).toEqual([]);

    const pol = await prisma.accPolicy.findFirstOrThrow({ where: { organizationId: ctx.organizationId } });
    await prisma.accPolicy.update({ where: { id: pol.id }, data: { params: { ...(pol.params as any), simplifiedRate: 3 } } });
    expect(lines(await decl.build(ctx, { form: '910.00', year: 2026, period: 'H1' }))['910.00.004']).toBe(g910.maslikhat3);
    await prisma.accPolicy.update({ where: { id: pol.id }, data: { params: { ...(pol.params as any), simplifiedRate: 7 } } });
    expect(((await decl.build(ctx, { form: '910.00', year: 2026, period: 'H1' })).checks as any[]).find((c) => c.code === 'C1').ok).toBe(false);

    await prisma.accPolicy.update({ where: { id: pol.id }, data: { params: { ...(pol.params as any), simplifiedRate: 3, simplifiedIncome: { exclude: ['6190'] } } } });
    const reg2 = await tax.buildSimplified(ctx, 2026, 'H1');
    expect((reg2.data as any).income).toBe(g910.excluded6190.income);
    await tax.fix(ctx, reg2.id, { reason: 'Излишки не доход по решению главбуха' });
    expect(lines(await decl.build(ctx, { form: '910.00', year: 2026, period: 'H1' }))['910.00.004']).toBe(g910.excluded6190.tax);

    await prisma.accPolicy.updateMany({ where: { organizationId: ctx.organizationId }, data: { taxRegime: 'GENERAL' } });
    expect(await code(tax.buildSimplified(ctx, 2026, 'H1'))).toBe('NOT_SIMPLIFIED');
  });

  it('ошибка контрольного соотношения — декларация не становится готовой', async () => {
    const { ctx } = await h1();
    const pol = await prisma.accPolicy.findFirstOrThrow({ where: { organizationId: ctx.organizationId } });
    await prisma.accPolicy.update({ where: { id: pol.id }, data: { params: { ...(pol.params as any), simplifiedRate: 9 } } });
    const reg = await tax.buildSimplified(ctx, 2026, 'H1');
    await tax.fix(ctx, reg.id, {});
    const d = await decl.build(ctx, { form: '910.00', year: 2026, period: 'H1' });
    expect(await code(decl.finalize(ctx, d.id))).toBe('CHECKS_FAILED');
    expect(await code(decl.build(ctx, { form: '910.00', year: 2026, period: 'Q1' }))).toBe('BAD_PERIOD');
    expect(await code(decl.build(ctx, { form: '200.00', year: 2026, period: 'Q1' }))).toBe('FORM_UNKNOWN');
  });
});
