// Печатные формы: встроенные шаблоны, версии шаблона организации, проверка разметки, «по умолчанию», неизменность
// версии в БД, данные документа (строки, НДС, прописью, роли сторон), чужой документ, не тот вид формы.
import { PrismaService } from '../src/prisma/prisma.service';
import { PrintService } from '../src/modules/accounting/print/print.service';
import { render } from '../src/modules/accounting/print/engine';
import { BUILTIN_TEMPLATES } from '../src/modules/accounting/print/templates';
import { makeOrg, makeServices, makeTrade } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const print = new PrintService(prisma);
afterAll(() => prisma.$disconnect());
async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? (/\b([A-Z_]{5,}): /.exec(String(e?.message))?.[1]) ?? e?.message; }
}

describe('Печатные формы', () => {
  it('шаблоны: встроенный по умолчанию → свой на его основе, версии, по умолчанию, архив; проверка разметки; неизменность', async () => {
    const ctx = await makeOrg(prisma);
    const list0 = await print.templates(ctx, 'INVOICE');
    expect(list0.map((t) => [t.id, t.isDefault])).toEqual([['builtin:INVOICE', true]]);
    expect(await code(print.save(ctx, { basedOn: 'builtin:INVOICE', name: 'Наш', html: '<script>x</script>' }))).toBe('TEMPLATE_INVALID');
    expect(await code(print.save(ctx, { basedOn: 'builtin:INVOICE', name: 'Наш', html: '{{#each lines}}' }))).toBe('TEMPLATE_INVALID');
    const v1 = await print.save(ctx, { basedOn: 'builtin:INVOICE', name: 'Наш счёт', html: '<p>{{doc.number}}</p>', makeDefault: true });
    expect([v1.version, v1.kind, v1.isDefault]).toEqual([1, 'INVOICE', true]);
    const v2 = await print.save(ctx, { family: v1.family, name: 'Наш счёт', html: '<p>№ {{doc.number}}</p>' });
    expect([v2.version, v2.isDefault]).toEqual([2, true]); // «по умолчанию» переходит к новой версии
    expect((await prisma.printTemplate.findUniqueOrThrow({ where: { id: v1.id } })).isDefault).toBe(false);
    const list = await print.templates(ctx, 'INVOICE');
    expect(list.map((t) => [t.name, t.version, t.isDefault])).toEqual([['Наш счёт', 2, true], ['Счёт на оплату (стандартный)', 0, false]]);
    expect((await print.template(ctx, v2.id) as any).versions.map((x: any) => x.version)).toEqual([2, 1]);
    // Вернуть встроенный по умолчанию.
    await print.setDefault(ctx, 'builtin:INVOICE');
    expect((await print.templates(ctx, 'INVOICE')).find((t) => t.builtin)!.isDefault).toBe(true);
    // БД: текст версии не меняется и не удаляется.
    expect(await code(prisma.printTemplate.update({ where: { id: v1.id }, data: { html: '<p>подмена</p>' } }))).toBe('ACC_IMMUTABLE');
    expect(await code(prisma.printTemplate.delete({ where: { id: v1.id } }))).toBe('ACC_IMMUTABLE');
    await print.archive(ctx, v1.family);
    expect((await print.templates(ctx, 'INVOICE')).map((t) => t.id)).toEqual(['builtin:INVOICE']);
    // Чужая организация шаблон не видит.
    const other = await makeOrg(prisma);
    expect(await code(print.template(other, v2.id))).toBe('NOT_FOUND');
  });

  it('данные реализации: строки, НДС, прописью, поставщик — мы; реквизиты для подписи; встроенный счёт отрисовывается', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    await print.saveSettings(ctx, { director: 'Иванов И. И.', kbe: '17' });
    expect(await code(print.saveSettings(ctx, { kbe: '7' }))).toBe('BAD_KBE');
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '2', price: '1160' }, { productId: t.service.id, qty: '1', price: '580' }] });
    const d: any = await print.data(ctx, 'INVOICE', sale.id);
    expect(d.lines.map((l: any) => [l.qty, l.price, l.amount, l.vat])).toEqual([['2.000', '1160.00', '2320.00', '320.00'], ['1.000', '580.00', '580.00', '80.00']]);
    expect(d.totals).toMatchObject({ amount: '2900.00', vat: '400.00', net: '2500.00', count: 2 });
    expect(d.amountWords).toBe('Две тысячи девятьсот тенге 00 тиын');
    expect([d.supplier.bin, d.buyer.name, d.org.director, d.org.kbe]).toEqual([d.org.bin, 'ТОО Покупатель', 'Иванов И. И.', '17']);
    // Накладная — только товары, акт — только услуги.
    expect((await print.data(ctx, 'Z2', sale.id) as any).lines.map((l: any) => l.name)).toEqual([expect.stringMatching(/^Товар/)]);
    expect((await print.data(ctx, 'R1', sale.id) as any).lines.map((l: any) => l.name)).toEqual(['Доставка']);
    const html = render(BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:INVOICE')!.html, d);
    expect(html).toContain('Две тысячи девятьсот тенге 00 тиын');
    expect(html).toContain('2 900,00');
    // Не тот вид формы, чужой документ.
    expect(await code(print.data(ctx, 'KO1', sale.id))).toBe('NOT_FOUND');
    const other = await makeOrg(prisma);
    expect(await code(print.data(other, 'INVOICE', sale.id))).toBe('NOT_FOUND');
    const po = await s.trade.create(ctx, { docType: 'MOVE', date: '2026-10-06', storeId: t.s1.id, storeToId: t.s2.id, status: 'DRAFT', lines: [{ productId: t.goods.id, qty: '1' }] } as any).catch(() => null);
    if (po) expect(await code(print.data(ctx, 'INVOICE', po.id))).toBe('WRONG_DOC_TYPE');
  });

  it('все встроенные шаблоны проходят проверку разметки и отрисовываются; З-2 — товары, количество прописью', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: true });
    await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '10', price: '100' }] });
    const sale = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '3', price: '232' }, { productId: t.service.id, qty: '1', price: '580' }] });
    for (const tpl of BUILTIN_TEMPLATES) {
      expect([tpl.id, (await import('../src/modules/accounting/print/engine')).validate(tpl.html)]).toEqual([tpl.id, []]);
      expect(tpl.source).not.toMatch(/НЕ СВЕРЕНО/);
    }
    const z2: any = await print.data(ctx, 'Z2', sale.id);
    expect([z2.qtyWords, z2.totals.amount, z2.totals.vat]).toEqual(['три', '696.00', '96.00']);
    const html = render(BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:Z2')!.html, z2);
    expect(html).toContain('Накладная на отпуск запасов на сторону');
    expect(html).toContain('Шестьсот девяносто шесть тенге 00 тиын');
    expect(html).not.toContain('Доставка');
    const r1 = render(BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:R1')!.html, await print.data(ctx, 'R1', sale.id) as any);
    expect(r1).toContain('Доставка');
    expect(r1).toContain('05.10.2026');
    const recon = render(BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:RECON')!.html, await print.data(ctx, 'RECON', '-', { counterpartyId: t.customer.id, from: '2026-10-01', to: '2026-10-31' }) as any);
    expect(recon).toContain('задолженность в пользу');
  });

  it('кассовый ордер: сумма прописью, от кого; акт сверки как данные', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const ko = await s.docs.create(ctx, { docType: 'CASH_IN', date: '2026-10-07', body: { cashboxId: t.cash.id, operation: 'CUSTOMER', counterpartyId: t.customer.id, amount: '1500.50', purpose: 'Оплата по счёту № 5' } });
    const d: any = await print.data(ctx, 'KO1', ko.id);
    expect([d.person, d.amount, d.amountWords, d.basis]).toEqual(['ТОО Покупатель', '1500.50', 'Одна тысяча пятьсот тенге 50 тиын', 'Оплата по счёту № 5']);
    expect(await code(print.data(ctx, 'KO2', ko.id))).toBe('WRONG_DOC_TYPE');
    await s.docs.post(ctx, ko.id);
    const posted: any = await print.data(ctx, 'KO1', ko.id);
    expect(posted.entry).toEqual({ debit: '1010', credit: '3510' }); // долга нет — аванс полученный
    const ko1 = render(BUILTIN_TEMPLATES.find((x) => x.id === 'builtin:KO1')!.html, posted);
    expect(ko1).toContain('ПРИХОДНЫЙ КАССОВЫЙ ОРДЕР');
    expect(ko1).toContain('Одна тысяча пятьсот тенге 50 тиын');
    expect(ko1).not.toMatch(/тиын<\/span> тенге/);
    const r: any = await print.data(ctx, 'RECON', '-', { counterpartyId: t.customer.id, from: '2026-10-01', to: '2026-10-31' });
    expect([r.opening, r.closing, r.closingCredit, r.result]).toEqual(['0.00', '-1500.50', '1500.50', 'задолженность в пользу ТОО Покупатель составляет 1500.50 тенге']); // аванс покупателя
  });
});

