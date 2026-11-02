// FP-041: основные средства и НМА. Эталон — вручную: ОС 120 000 ₸ на 36 мес. → 3 333,33 в месяц с февраля (принят
// 15.01); выбытие 20.05 после начисления за май: накоплено 13 333,32, остаточная 106 666,68 → 7110. НМА 1 000 ₸ на
// 3 мес. → 333,33 + 333,33 + 333,34 (последний месяц — остаток), дальше не начисляется.
import { PrismaService } from '../src/prisma/prisma.service';
import { AssetsService, monthlyAmount } from '../src/modules/accounting/assets/assets.service';
import { D } from '../src/modules/accounting/common/money';
import { makeOrg, makeServices, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const assets = new AssetsService(prisma, s.docs, s.posting, (s as any).periods ?? new (require('../src/modules/accounting/periods/periods.service').PeriodsService)(prisma));
afterAll(() => prisma.$disconnect());
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? (/\b([A-Z_]{5,}): /.exec(String(e?.message))?.[1]) ?? e?.message; }
}
async function postings(ctx: any, sourceType: string, sourceId: string) {
  const ps = await prisma.accPosting.findMany({ where: { organizationId: ctx.organizationId, isActive: true, entry: { sourceType, sourceId, status: 'ACTIVE' } }, include: { account: { select: { code: true } } }, orderBy: [{ side: 'asc' }, { lineNo: 'asc' }] });
  return ps.map((p) => [p.side, p.account.code, p.amount.toFixed(2)]);
}

describe('FP-041: основные средства', () => {
  it('жизненный цикл ОС: принятие от поставщика с НДС, амортизация по месяцам, пропуск, выбытие, блокировки', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    const a = await assets.create(ctx, { name: 'Ноутбук Lenovo', cost: '120000', usefulLifeMonths: 36 });
    expect([a.inventoryNumber, a.assetAccount, a.deprAccount, a.expenseAccount]).toEqual(['ОС-00001', '2410', '2420', '7030']);
    expect(await code(assets.create(ctx, { name: 'Дубль', inventoryNumber: 'ОС-00001', cost: '1', usefulLifeMonths: 1 }))).toBe('INVENTORY_NUMBER_TAKEN');
    expect(await code(assets.create(ctx, { name: 'Без срока', cost: '1', usefulLifeMonths: 0 }))).toBe('ASSET_LIFE_REQUIRED');
    expect(await code(assets.create(ctx, { name: 'Кривая сумма', cost: '12abc', usefulLifeMonths: 12 }))).toBe('BAD_AMOUNT');
    expect((await assets.create(ctx, { name: 'Пустая ликвидационная', cost: '1 200,50', salvage: '', usefulLifeMonths: 12 })).salvage.toFixed(2)).toBe('0.00'); // как из формы

    const acc = await assets.accept(ctx, a.id, { date: '2026-01-15', source: 'SUPPLIER', counterpartyId: t.supplier.id, vatAmount: '19200' });
    expect(await postings(ctx, 'ACC_DOCUMENT', acc.id)).toEqual([['C', '3310', '139200.00'], ['D', '2410', '120000.00'], ['D', '1420', '19200.00']]);
    expect((await assets.get(ctx, a.id)).status).toBe('IN_USE');
    expect(await code(assets.accept(ctx, a.id, { date: '2026-01-16' }))).toBe('ASSET_ALREADY_ACCEPTED');
    // То же — в обход сервиса: второй документ принятия не проводится (правило проводок).
    const dup = await s.docs.create(ctx, { docType: 'ASSET_ACCEPT', date: '2026-01-20', body: { assetId: a.id, cost: '120000.00', source: 'OTHER', corrAccount: '2930' } });
    expect(await code(s.docs.post(ctx, dup.id))).toBe('ASSET_ALREADY_ACCEPTED');
    expect(await code(assets.update(ctx, a.id, { cost: '100000' }))).toBe('ASSET_LOCKED');
    expect((await assets.update(ctx, a.id, { name: 'Ноутбук Lenovo T14' })).name).toBe('Ноутбук Lenovo T14');

    // Январь — месяц принятия, амортизации нет; февраль, март.
    expect(await assets.depreciate(ctx, '2026-01')).toMatchObject({ rows: 0 });
    expect(await assets.depreciate(ctx, '2026-02')).toMatchObject({ rows: 1, total: '3333.33' });
    expect(await postings(ctx, 'ASSET_DEPRECIATION', '2026-02')).toEqual([['C', '2420', '3333.33'], ['D', '7030', '3333.33']]);
    expect(await assets.depreciate(ctx, '2026-02')).toMatchObject({ changed: false });
    // Пропуск месяца — ошибка.
    expect(await code(assets.depreciate(ctx, '2026-04'))).toBe('ASSET_DEPR_GAP');
    await assets.depreciate(ctx, '2026-03');
    await assets.depreciate(ctx, '2026-04');
    // Снять принятие при начисленной амортизации — нельзя.
    expect(await code(s.docs.unpost(ctx, acc.id, { reason: 'ошибка' }))).toBe('ASSET_IN_USE');
    // Выбытие в мае — сначала амортизация за май.
    expect(await code(assets.dispose(ctx, a.id, { date: '2026-05-20', reason: 'Списание: поломка' }))).toBe('ASSET_DEPR_REQUIRED');
    expect((await prisma.accDocument.count({ where: { organizationId: ctx.organizationId, docType: 'ASSET_DISPOSE', status: 'POSTED' } }))).toBe(0);
    await assets.depreciate(ctx, '2026-05');
    expect(await code(assets.dispose(ctx, a.id, { date: '2026-05-20', reason: 'нет' }))).toBe('REASON_REQUIRED');
    const disp = await assets.dispose(ctx, a.id, { date: '2026-05-20', reason: 'Списание: поломка' });
    expect(await postings(ctx, 'ACC_DOCUMENT', disp.id)).toEqual([['C', '2410', '120000.00'], ['D', '2420', '13333.32'], ['D', '7110', '106666.68']]);
    const after = await assets.get(ctx, a.id);
    expect([after.status, after.accumulated, after.bookValue]).toEqual(['DISPOSED', '13333.32', '0.00']);
    // После выбытия — не начисляется; отменить май нельзя, пока есть выбытие.
    expect(await assets.depreciate(ctx, '2026-06')).toMatchObject({ rows: 0 });
    expect(await code(assets.cancelDepreciation(ctx, '2026-05', 'Пересчёт мая'))).toBe('ASSET_DISPOSED_IN_PERIOD');
  });

  it('НМА: последний месяц — остаток; отмена месяца с причиной; закрытие месяца требует амортизацию', async () => {
    const ctx = await makeOrg(prisma);
    await makeTrade(prisma, ctx, { vatPayer: false });
    const n = await assets.create(ctx, { kind: 'INTANGIBLE', name: 'Лицензия ПО', cost: '1000', usefulLifeMonths: 3, expenseAccount: '7020' });
    expect([n.inventoryNumber, n.assetAccount, n.deprAccount]).toEqual(['НМА-00001', '2730', '2740']);
    await assets.accept(ctx, n.id, { date: '2026-03-31', source: 'OTHER', corrAccount: '2930' });
    const close = await (s as any).closing.status(ctx, '2026-04');
    expect(close.steps.find((x: any) => x.code === 'DEPRECIATION')).toMatchObject({ status: 'error' });
    const amounts: string[] = [];
    for (const p of ['2026-04', '2026-05', '2026-06', '2026-07']) amounts.push((await assets.depreciate(ctx, p)).total);
    expect(amounts).toEqual(['333.33', '333.33', '333.34', '0.00']);
    expect((await assets.get(ctx, n.id)).bookValue).toBe('0.00');
    expect((await (s as any).closing.status(ctx, '2026-04')).steps.find((x: any) => x.code === 'DEPRECIATION')).toMatchObject({ status: 'ok' });
    // Отмена — с причиной, только последнего месяца.
    expect(await code(assets.cancelDepreciation(ctx, '2026-05', 'Пересчёт'))).toBe('ASSET_DEPR_LATER');
    expect(await code(assets.cancelDepreciation(ctx, '2026-07', 'нет'))).toBe('REASON_REQUIRED');
    await assets.cancelDepreciation(ctx, '2026-06', 'Ошибка в сроке, пересчёт');
    expect(await postings(ctx, 'ASSET_DEPRECIATION', '2026-06')).toEqual([]);
    expect((await assets.register(ctx, '2026-06')).preview.map((r: any) => r.amount)).toEqual(['333.34']);
    expect(await prisma.auditLog.count({ where: { organizationId: ctx.organizationId, action: 'ASSET_DEPRECIATION_CANCELLED', reason: 'Ошибка в сроке, пересчёт' } })).toBe(1);
  });

  it('ликвидационная стоимость не амортизируется', () => {
    const a = { cost: '1000', salvage: '100', usefulLifeMonths: 3 };
    expect(monthlyAmount(a, '2026-04', '2026-04', new D(0))!.toFixed(2)).toBe('300.00');
    expect(monthlyAmount(a, '2026-04', '2026-06', new D(600))!.toFixed(2)).toBe('300.00');
    expect(monthlyAmount(a, '2026-04', '2026-07', new D(900))).toBeNull();
    expect(monthlyAmount(a, '2026-04', '2026-03', new D(0))).toBeNull();
  });
});
