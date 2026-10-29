import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from '../src/prisma/prisma.service';
import { EsfService } from '../src/modules/accounting/esf/esf.service';
import { esfDate, parseInvoice } from '../src/modules/accounting/esf/invoice-xml';
import { EsfSoapClient } from '../src/modules/accounting/esf/esf-soap.client';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';
import { makeCertFactory } from './esf-certs';

const prisma = new PrismaService();
const s = makeServices(prisma);
const esf = new EsfService(prisma);
const XSD = join(__dirname, 'fixtures/esf/invoice_v2.xsd');

async function expectCode(p: Promise<any>, code: string) {
  await expect(p).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
}

/** Проверка XML официальной XSD ИС ЭСФ (xmllint из libxml2). */
function validateXsd(xml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'esf-'));
  const f = join(dir, 'invoice.xml');
  writeFileSync(f, xml);
  execFileSync('xmllint', ['--noout', '--schema', XSD, f], { stdio: 'pipe' });
}

/** Поддельная ИС ЭСФ: отвечает по имени операции, запоминает запросы. */
function fakeEsf(handlers: Record<string, (body: string) => string>) {
  const calls: { service: string; body: string }[] = [];
  const fetcher = async (url: string, init: any) => {
    const service = url.split('/').pop()!;
    calls.push({ service, body: init.body });
    const op = Object.keys(handlers).find((k) => init.body.includes(`esf:${k}Request`));
    const inner = op ? handlers[op](init.body) : '';
    const xml = op
      ? `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:${op}Response xmlns:ns2="esf">${inner}</ns2:${op}Response></soap:Body></soap:Envelope>`
      : `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>no handler</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    return { status: 200, text: async () => xml };
  };
  return { fetcher, calls };
}

async function setupOrg(opts: { vatPayer?: boolean } = {}) {
  const ctx = await makeOrg(prisma);
  const t = await makeTrade(prisma, ctx, { vatPayer: opts.vatPayer ?? true });
  await prisma.organization.update({ where: { id: ctx.organizationId }, data: { inn: '123456789021', address: 'г. Астана, ул. Тестовая, 1' } });
  await prisma.uom.update({ where: { id: t.uom.id }, data: { code: '796' } });
  await prisma.counterparty.update({ where: { id: t.customer.id }, data: { inn: '123456789011', fullName: 'ТОО «Покупатель»' } });
  return { ctx, t };
}

async function stockAndSell(ctx: any, t: any, date = '2026-10-05') {
  await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '1160' }], status: 'POSTED' });
  return s.trade.create(ctx, {
    docType: 'DEMAND', date, counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED',
    lines: [{ productId: t.goods.id, qty: '3', price: '2320' }, { productId: t.service.id, qty: '1', price: '1160' }],
  });
}

// Тестовые ключи «как у НУЦ»: ИИН подписанта = БИН организации в этих тестах (123456789021).
const certs = makeCertFactory();
const signer = certs.cert({ iin: '123456789021', bin: '123456789021' });
const authKey = certs.cert({ iin: '123456789021', bin: '123456789021', keyUsage: 'digitalSignature,keyEncipherment' });
const certB64 = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
afterAll(() => certs.cleanup());

beforeAll(async () => {
  await prisma.$connect();
  await s.chart.bootstrap();
});
afterAll(async () => prisma.$disconnect());

describe('ЭСФ: формирование только из учёта', () => {
  it('не хватает реквизитов — понятный список, что заполнить', async () => {
    const { ctx, t } = await setupOrg();
    const sale = await stockAndSell(ctx, t);
    const err = await esf.prepare(ctx, sale.id).catch((e) => e.response);
    expect(err.code).toBe('ESF_DATA_INCOMPLETE');
    const text = err.details.problems.join('\n');
    expect(text).toMatch(/дата постановки на учёт по НДС/);
    expect(text).toMatch(/способ отправления/);
    expect(text).toMatch(/признак происхождения/);
  });

  it('черновик и неотражённый документ — ЭСФ не выписывается', async () => {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { vatRegistrationDate: '2020-01-15', transportTypeCode: '30', defaultGoodsOrigin: '5' });
    const draft = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-05', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.service.id, qty: '1', price: '100' }] });
    await expectCode(esf.prepare(ctx, draft.id), 'ESF_NOT_POSTED');
    const supply = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '100' }], status: 'POSTED' });
    await expectCode(esf.prepare(ctx, supply.id), 'ESF_DOC_TYPE');
  });

  it('ЭСФ проходит официальную XSD и совпадает с проводками до тиына', async () => {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { vatRegistrationDate: '2020-01-15', transportTypeCode: '30', defaultGoodsOrigin: '5', operatorFullname: 'Тестов Тест' });
    const sale = await stockAndSell(ctx, t);
    const inv = await esf.prepare(ctx, sale.id, new Date('2026-10-06T00:00:00Z'));
    expect(inv.status).toBe('READY');
    expect(inv.num).toMatch(/^2026\d{6}$/);
    validateXsd(inv.body);

    const p = parseInvoice(inv.body);
    expect(p.date).toBe('06.10.2026');
    expect(p.turnoverDate).toBe('05.10.2026');
    expect(p.seller.tin).toBe('123456789021');
    expect(p.customer.tin).toBe('123456789011');
    // 3 × 2320 + 1160 = 8120 с НДС 16%: НДС 1120, без НДС 7000
    expect(p.totals).toEqual({ ndsAmount: '1120.00', priceWithTax: '8120.00', priceWithoutTax: '7000.00' });
    expect(p.products.map((x) => x.truOriginCode)).toEqual(['5', '6']);
    expect(p.products[0].unitNomenclature).toBe('796');
    expect(p.products[1].unitNomenclature).toBeUndefined(); // услуга — без единицы

    const vatOut = sale.entry!.postings.filter((x: any) => x.account.code === '3130').reduce((a: number, x: any) => a + Number(x.amount), 0);
    const revenue = sale.entry!.postings.filter((x: any) => x.account.code === '6010').reduce((a: number, x: any) => a + Number(x.amount), 0);
    expect(Number(inv.totalNds)).toBe(vatOut);
    expect(Number(inv.totalWithoutTax)).toBe(revenue);

    // повторный вызов не плодит ЭСФ и не меняет номер
    const again = await esf.prepare(ctx, sale.id, new Date('2026-10-06T00:00:00Z'));
    expect(again.id).toBe(inv.id);
    expect(again.num).toBe(inv.num);
  });

  it('неплательщик НДС: «Без НДС», без даты постановки на учёт', async () => {
    const { ctx, t } = await setupOrg({ vatPayer: false });
    await esf.updateSettings(ctx, { transportTypeCode: '30', defaultGoodsOrigin: '4' });
    const sale = await stockAndSell(ctx, t);
    const inv = await esf.prepare(ctx, sale.id);
    validateXsd(inv.body);
    expect(inv.body).not.toContain('<ndsRate>');
    expect(inv.body).not.toContain('ndsRegistrationDate');
    expect(Number(inv.totalNds)).toBe(0);
    expect(Number(inv.totalWithTax)).toBe(8120);
  });
});

describe('ЭСФ: вход, подпись, отправка, статусы', () => {
  it('сквозной цикл с ИС ЭСФ: тикет → сессия → подпись → syncInvoice → статус DELIVERED; ФЛК-отказ виден с текстом', async () => {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021', vatRegistrationDate: '2020-01-15', transportTypeCode: '30', defaultGoodsOrigin: '5' });
    const sale1 = await stockAndSell(ctx, t, '2026-10-05');
    const sale2 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.service.id, qty: '1', price: '580' }] });
    const i1 = await esf.prepare(ctx, sale1.id);
    const i2 = await esf.prepare(ctx, sale2.id);

    let uploaded = '';
    const fake = fakeEsf({
      createAuthTicket: () => '<authTicketXml>&lt;authSign&gt;&lt;iin&gt;123456789021&lt;/iin&gt;&lt;/authSign&gt;</authTicketXml>',
      createSessionSigned: () => '<sessionId>S-1</sessionId>',
      syncInvoice: (b) => {
        uploaded = b;
        const d = esfDate(new Date());
        // решение по номеру ЭСФ, а не по позиции в пакете
        return `<acceptedSet><standardResponse><id>9001</id><num>${i1.num}</num><date>${d}</date></standardResponse></acceptedSet>` +
          `<declinedSet><standardResponse><num>${i2.num}</num><date>${d}</date><errors><error><property>customers.customer.tin</property><errorCode>TIN_NOT_FOUND</errorCode><text>Получатель не найден</text></error></errors></standardResponse></declinedSet>`;
      },
      queryInvoiceSummaryById: () => '<invoiceSummaryList><invoiceSummary><invoiceId>9001</invoiceId><invoiceStatus>DELIVERED</invoiceStatus><registrationNumber>ESF-123456789021-20261023-0001</registrationNumber></invoiceSummary></invoiceSummaryList>',
      queryUpdates: () => `<lastEventDate>2026-10-23T10:00:00.000+05:00</lastEventDate><lastBlock>true</lastBlock><invoiceInfoList/>`,
    });
    esf.fetcher = fake.fetcher;

    await expectCode(esf.upload(ctx, { certificate: 'MIIC', items: [{ id: i1.id, signature: 'x' }] }), 'ESF_NO_SESSION');
    const tk = await esf.ticket(ctx);
    expect(tk.ticket).toContain('<authSign>');
    await expectCode(esf.openSession(ctx, 'not signed'), 'ESF_BAD_TICKET');
    const sess = await esf.openSession(ctx, '<authSign><ds:Signature/></authSign>');
    expect(sess.iin).toBe('123456789021');
    expect(fake.calls.find((c) => c.service === 'SessionService')!.body).toContain('<tin>123456789021</tin>');

    const sd = await esf.signData(ctx, [i1.id, i2.id]);
    expect(sd.version).toBe('InvoiceV2');
    expect(sd.items[0].bytesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sd.items).toHaveLength(2);
    expect(parseInvoice(sd.items[0].body).date).toBe(esfDate(new Date())); // дата выписки = день подписи

    await expectCode(esf.upload(ctx, { certificate: 'MIIC', items: [{ id: i1.id, signature: 'A'.repeat(500) }, { id: i2.id, signature: 'x' }] }), 'ESF_SIGNATURE');

    // FP-016: подпись принимается только по запросу на подпись, только ключом подписи, только над теми же байтами
    const signed = (data: typeof sd, key = signer) => data.items.map((i) => ({ id: i.id, signature: key.sign(i.body), signingToken: i.signingToken }));
    const noToken = signed(sd).map(({ id, signature }) => ({ id, signature }));
    await expectCode(esf.upload(ctx, { certificate: signer.pem, items: noToken }), 'ESF_SIGN_REQUEST_INVALID');
    await expectCode(esf.upload({ ...ctx, userId: 'someone-else' }, { certificate: signer.pem, items: signed(sd) }), 'ESF_SIGN_REQUEST_INVALID');
    await expectCode(esf.upload(ctx, { certificate: authKey.pem, items: signed(sd, authKey) }), 'ESF_SIGNER_NOT_AUTHORIZED');
    const wrongBytes = signed(sd).map((x, k) => ({ ...x, signature: signer.sign(sd.items[k].body + ' ') }));
    await expectCode(esf.upload(ctx, { certificate: signer.pem, items: wrongBytes }), 'ESF_SIGNATURE_INVALID');
    // документ пересобран после выдачи на подпись (другая дата выписки) — старая подпись устарела
    const stale = signed(sd);
    await esf.prepare(ctx, sale1.id, new Date('2026-10-07T00:00:00Z'));
    await expectCode(esf.upload(ctx, { certificate: signer.pem, items: stale }), 'ESF_STALE_SIGNATURE');
    expect(fake.calls.filter((c) => c.body.includes('syncInvoiceRequest'))).toHaveLength(0); // ни одна попытка не ушла в ИС ЭСФ

    const sd2 = await esf.signData(ctx, [i1.id, i2.id]);
    const items = signed(sd2);
    const up = await esf.upload(ctx, { certificate: signer.pem, items });
    expect(up).toMatchObject({ accepted: 1, declined: 1 });
    expect(uploaded).toContain(`<x509Certificate>${certB64(signer.pem)}</x509Certificate>`);

    // в журнале — доказательства проверки, но не подпись и не сертификат
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: ctx.organizationId, action: 'ESF_UPLOAD' }, orderBy: { ts: 'desc' } });
    const auditText = JSON.stringify(audit);
    expect((audit!.after as any).signing).toEqual(expect.arrayContaining([expect.objectContaining({ verification: 'VERIFIED', signerIin: '123456789021', keyType: 'rsa' })]));
    expect(auditText).not.toContain(items[0].signature.slice(0, 32));
    expect(auditText).not.toContain(certB64(signer.pem).slice(40, 100));
    expect(uploaded).toContain('<signatureType>COMPANY</signatureType>');
    // тело отправлено ровно тем, что подписано
    const sent = await prisma.esfInvoice.findUnique({ where: { id: i1.id } });
    expect(uploaded).toContain(sent!.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(sent!.status).toBe('SENT');
    expect(sent!.esfId?.toString()).toBe('9001');
    const rej = await esf.get(ctx, i2.id);
    expect(rej.status).toBe('REJECTED');
    expect((rej.errors as any[])[0].text).toBe('Получатель не найден');

    // повторная отправка уже отправленного запрещена
    await expectCode(esf.signData(ctx, [i1.id]), 'ESF_STATUS');

    const r = await esf.refresh(ctx);
    expect(r.updated).toBe(1);
    const done = await esf.get(ctx, i1.id);
    expect(done.status).toBe('DELIVERED');
    expect(done.registrationNumber).toBe('ESF-123456789021-20261023-0001');

    // документ отменили после отправки → ЭСФ помечен «требует исправления»
    await s.trade.cancel(ctx, sale1.id);
    await esf.markOutdated(ctx.organizationId, 'TEST');
    expect((await esf.get(ctx, i1.id)).outdated).toBe(true);
  });

  it('закрытая сессия ИС ЭСФ → понятная ошибка и сессия сбрасывается', async () => {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021', vatRegistrationDate: '2020-01-15', transportTypeCode: '30', defaultGoodsOrigin: '5' });
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'OLD', iin: '123456789021', tin: '123456789021' } });
    esf.fetcher = async () => ({ status: 500, text: async () => '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>Session closed</faultstring><detail><ns2:sessionClosedException xmlns:ns2="esf"><description>Сессия закрыта</description></ns2:sessionClosedException></detail></soap:Fault></soap:Body></soap:Envelope>' });
    const sale = await stockAndSell(ctx, t);
    const inv = await esf.prepare(ctx, sale.id);
    await prisma.esfInvoice.update({ where: { id: inv.id }, data: { status: 'SENT', esfId: BigInt(Date.now()) } });
    await expectCode(esf.refresh(ctx), 'ESF_SESSION_CLOSED');
    expect((await esf.settings(ctx)).session).toBeNull();
  });

  it('входящие ЭСФ загружаются в реестр и привязываются к поставщику по БИН', async () => {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021' });
    await prisma.counterparty.update({ where: { id: t.supplier.id }, data: { inn: '987654321098' } });
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'S', iin: '123456789021', tin: '123456789021' } });
    const supply = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-01', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '10', price: '1160' }], status: 'POSTED' });
    const body = `<?xml version="1.0" encoding="UTF-8"?><v2:invoice xmlns:a="abstractInvoice.esf" xmlns:v2="v2.esf"><date>02.10.2026</date><invoiceType>ORDINARY_INVOICE</invoiceType><num>77</num><operatorFullname>X</operatorFullname><turnoverDate>01.10.2026</turnoverDate><customers><customer><countryCode>KZ</countryCode><name>Мы</name><tin>123456789021</tin></customer></customers><deliveryTerm><hasContract>false</hasContract><paymentForm>NON_CASH</paymentForm></deliveryTerm><productSet><currencyCode>KZT</currencyCode><products><product><catalogTruId>1</catalogTruId><description>Яблоки</description><ndsAmount>1600.00</ndsAmount><ndsRate>16</ndsRate><priceWithTax>11600.00</priceWithTax><priceWithoutTax>10000.00</priceWithoutTax><truOriginCode>4</truOriginCode><turnoverSize>10000.00</turnoverSize></product></products><totalExciseAmount>0</totalExciseAmount><totalNdsAmount>1600.00</totalNdsAmount><totalPriceWithTax>11600.00</totalPriceWithTax><totalPriceWithoutTax>10000.00</totalPriceWithoutTax><totalTurnoverSize>10000.00</totalTurnoverSize></productSet><sellers><seller><name>ТОО Поставщик</name><tin>987654321098</tin></seller></sellers></v2:invoice>`;
    let confirmed = '';
    const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    esf.fetcher = fakeEsf({
      queryUpdates: () => `<lastEventDate>2026-10-23T10:00:00.000+05:00</lastEventDate><lastInvoiceId>555</lastInvoiceId><lastBlock>true</lastBlock><invoiceInfoList><invoiceInfo><invoiceBody>${esc}</invoiceBody><invoiceId>555</invoiceId><registrationNumber>ESF-987654321098-20261002-0077</registrationNumber><inputDate>2026-10-02T10:00:00+05:00</inputDate><lastUpdateDate>2026-10-02T10:00:00+05:00</lastUpdateDate><signatureValid>true</signatureValid><invoiceStatus>CREATED</invoiceStatus><version>InvoiceV2</version><signature>x</signature><signatureType>COMPANY</signatureType><certificate>x</certificate></invoiceInfo></invoiceInfoList>`,
      confirmInvoiceById: (b) => { confirmed = b; return '<invoiceSummaryList><invoiceSummary><invoiceId>555</invoiceId><invoiceStatus>DELIVERED</invoiceStatus></invoiceSummary></invoiceSummaryList>'; },
    }).fetcher;
    const r = await esf.refresh(ctx);
    expect(r.inbound).toBe(1);
    const list = await esf.list(ctx, { direction: 'INBOUND' });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ num: '77', sellerTin: '987654321098', registrationNumber: 'ESF-987654321098-20261002-0077' });
    expect(Number(list.items[0].totalNds)).toBe(1600);
    const row = await prisma.esfInvoice.findFirst({ where: { organizationId: ctx.organizationId, direction: 'INBOUND' } });
    expect(row!.counterpartyId).toBe(t.supplier.id);
    expect(row!.sourceDocId).toBe(supply.id); // привязан к поступлению: тот же поставщик и сумма
    expect(confirmed).toContain('<id>555</id>');
    expect(row!.status).toBe('DELIVERED');
    // повторная загрузка не дублирует
    await esf.refresh(ctx);
    expect((await esf.list(ctx, { direction: 'INBOUND' })).items).toHaveLength(1);
    expect((await esf.settings(ctx)).inboundLastId).toBe('555');
  });
});

// Живой вызов тестового стенда КГД (без ЭЦП доступен только выдача тикета). Запуск: ESF_LIVE=1
(process.env.ESF_LIVE === '1' ? describe : describe.skip)('ИС ЭСФ тестовый стенд (живой вызов)', () => {
  it('AuthService.createAuthTicket отдаёт тикет для подписи', async () => {
    const t = await EsfSoapClient.forEnvironment('TEST').createAuthTicket('123456789021', 5);
    expect(t).toContain('<authSign>');
    expect(t).toContain('<iin>123456789021</iin>');
  });
});

describe('ЭСФ: возврат (дополнительный ЭСФ) и отзыв', () => {
  async function registeredSale() {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021', vatRegistrationDate: '2020-01-15', transportTypeCode: '30', defaultGoodsOrigin: '5' });
    const sale = await stockAndSell(ctx, t, '2026-10-05');
    const inv = await esf.prepare(ctx, sale.id, new Date('2026-10-06T00:00:00Z'));
    const esfId = BigInt(Date.now()) * 10n + BigInt(Math.floor(Math.random() * 10));
    // как после отправки и регистрации в ИС ЭСФ
    await prisma.esfInvoice.update({ where: { id: inv.id }, data: { status: 'DELIVERED', esfStatus: 'DELIVERED', esfId, registrationNumber: `ESF-123456789021-20261006-${esfId % 100000n}` } });
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'S', iin: '123456789021', tin: '123456789021' } });
    return { ctx, t, sale, inv: (await prisma.esfInvoice.findUnique({ where: { id: inv.id } }))! };
  }

  it('возврат на основании реализации → дополнительный ЭСФ: ссылка на основной, разница со знаком «минус», XSD', async () => {
    const { ctx, t, sale, inv } = await registeredSale();
    // без основания — понятная ошибка
    const orphan = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-08', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '2320' }] });
    await expectCode(esf.prepare(ctx, orphan.id), 'ESF_RETURN_NO_BASE');

    const ret = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-09', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale.id, lines: [{ productId: t.goods.id, qty: '1', price: '2320' }] });
    const add = await esf.prepare(ctx, ret.id, new Date('2026-10-10T00:00:00Z'));
    validateXsd(add.body);
    expect(add.invoiceType).toBe('ADDITIONAL_INVOICE');
    expect(add.relatedInvoiceId).toBe(inv.id);
    const p = parseInvoice(add.body);
    expect(p.invoiceType).toBe('ADDITIONAL_INVOICE');
    expect(p.relatedInvoice).toEqual({ date: '06.10.2026', num: inv.num, registrationNumber: inv.registrationNumber });
    expect(p.turnoverDate).toBe('09.10.2026');
    expect(p.totals).toEqual({ ndsAmount: '-320.00', priceWithTax: '-2320.00', priceWithoutTax: '-2000.00' });
    expect(p.products[0].quantity).toBe('-1');
    expect(Number(add.totalWithTax)).toBe(-2320);
    // совпадает с проводками возврата (уменьшение НДС к уплате)
    const vatBack = ret.entry!.postings.filter((x: any) => x.account.code === '3130').reduce((a: number, x: any) => a + Number(x.amount), 0);
    expect(-Number(add.totalNds)).toBe(vatBack);
    // возвраты не могут превысить сумму основного ЭСФ (8120)
    const big = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-09', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale.id, lines: [{ productId: t.goods.id, qty: '3', price: '2320' }] });
    await expectCode(esf.prepare(ctx, big.id), 'ESF_RETURN_EXCEEDS');
    // возврат по реализации без зарегистрированного ЭСФ
    const sale2 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-07', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.goods.id, qty: '1', price: '2320' }] });
    const ret2 = await s.trade.create(ctx, { docType: 'SALES_RETURN', date: '2026-10-09', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', baseId: sale2.id, lines: [{ productId: t.goods.id, qty: '1', price: '2320' }] });
    await expectCode(esf.prepare(ctx, ret2.id), 'ESF_RETURN_BASE_NOT_REGISTERED');
  });

  it('отзыв: подписывается список {id, причина} в формате SDK; результат ИС ЭСФ сохраняется; для неподходящих — отказ', async () => {
    const { ctx, inv } = await registeredSale();
    await expectCode(esf.actionData(ctx, { action: 'REVOKE', ids: [inv.id] }), 'ESF_REASON');
    const d = await esf.actionData(ctx, { action: 'REVOKE', ids: [inv.id], reason: 'Ошибка в цене "А&Б"' });
    expect(d.data).toBe(`<signedContent><idsWithReasons><idWithReason><id>${inv.esfId}</id><reason>Ошибка в цене "А&amp;Б"</reason></idWithReason></idsWithReasons></signedContent>`);

    let req = '';
    esf.fetcher = fakeEsf({
      revokeInvoiceById: (b) => { req = b; return `<resultList><changeStatusResult><invoiceSummary><invoiceId>${inv.esfId}</invoiceId><invoiceStatus>WAITING_CUSTOMER_REVOKE_CONFIRMATION</invoiceStatus></invoiceSummary><isChanged>true</isChanged></changeStatusResult></resultList>`; },
      queryInvoiceSummaryById: () => `<invoiceSummaryList><invoiceSummary><invoiceId>${inv.esfId}</invoiceId><invoiceStatus>REVOKED</invoiceStatus></invoiceSummary></invoiceSummaryList>`,
      queryUpdates: () => `<lastEventDate>2026-10-23T10:00:00.000+05:00</lastEventDate><lastBlock>true</lastBlock><invoiceInfoList/>`,
    }).fetcher;
    // причина изменилась после выдачи на подпись — подписанные байты уже другие
    await expectCode(esf.action(ctx, { action: 'REVOKE', ids: [inv.id], reason: 'Другая причина', signature: signer.sign(d.data), certificate: signer.pem, signingToken: d.signingToken }), 'ESF_STALE_SIGNATURE');
    expect(req).toBe('');
    const r = await esf.action(ctx, { action: 'REVOKE', ids: [inv.id], reason: 'Ошибка в цене "А&Б"', signature: signer.sign(d.data), certificate: signer.pem, signingToken: d.signingToken });
    expect(r.changed).toBe(1);
    expect(req).toContain('<esf:revokeInvoiceByIdRequest>');
    expect(req).toContain(`<invoiceIdWithReason><id>${inv.esfId}</id><reason>Ошибка в цене "А&amp;Б"</reason></invoiceIdWithReason>`);
    let row = await prisma.esfInvoice.findUnique({ where: { id: inv.id } });
    expect(row).toMatchObject({ status: 'SENT', esfStatus: 'WAITING_CUSTOMER_REVOKE_CONFIRMATION', cancelReason: 'Ошибка в цене "А&Б"' });
    // покупатель подтвердил — опрос статуса доводит до REVOKED
    await esf.refresh(ctx);
    row = await prisma.esfInvoice.findUnique({ where: { id: inv.id } });
    expect(row!.status).toBe('REVOKED');
    // повторный отзыв недоступен
    await expectCode(esf.actionData(ctx, { action: 'REVOKE', ids: [inv.id], reason: 'x' }), 'ESF_ACTION_NOT_ALLOWED');
  });

  it('входящие: подтверждение дополнительного ЭСФ и подтверждение отзыва (подпись списка id)', async () => {
    const { ctx } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021' });
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'S', iin: '123456789021', tin: '123456789021' } });
    const mk = (esfId: bigint, invoiceType: string, st: string) => prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', invoiceType, num: String(esfId), date: new Date('2026-10-10'), turnoverDate: new Date('2026-10-10'), status: st, esfStatus: st, esfId, body: '<x/>', bodyHash: 'x' } });
    const base = BigInt(Date.now()) * 100n;
    const add = await mk(base + 1n, 'ADDITIONAL_INVOICE', 'WAITING_CUSTOMER_CONFIRMATION');
    const rev = await mk(base + 2n, 'ORDINARY_INVOICE', 'WAITING_CUSTOMER_REVOKE_CONFIRMATION');
    const approve = await esf.actionData(ctx, { action: 'APPROVE', ids: [add.id] });
    expect(approve.data).toBe(`<signedContent><ids><id>${base + 1n}</id></ids></signedContent>`);
    await expectCode(esf.actionData(ctx, { action: 'APPROVE', ids: [rev.id] }), 'ESF_ACTION_NOT_ALLOWED');
    const ops: string[] = [];
    esf.fetcher = fakeEsf({
      approveInvoiceById: () => { ops.push('approve'); return `<resultList><changeStatusResult><invoiceSummary><invoiceId>${base + 1n}</invoiceId><invoiceStatus>DELIVERED</invoiceStatus></invoiceSummary><isChanged>true</isChanged></changeStatusResult></resultList>`; },
      revokeConfirmInvoiceById: () => { ops.push('confirmRevoke'); return `<resultList><changeStatusResult><invoiceSummary><invoiceId>${base + 2n}</invoiceId><invoiceStatus>REVOKED</invoiceStatus></invoiceSummary><isChanged>true</isChanged></changeStatusResult></resultList>`; },
    }).fetcher;
    await expectCode(esf.action(ctx, { action: 'APPROVE', ids: [add.id], signature: 's', certificate: 'c', signingToken: approve.signingToken }), 'ESF_CERT');
    // токен одной операции не подходит для другой
    await expectCode(esf.action(ctx, { action: 'CONFIRM_REVOKE', ids: [rev.id], signature: signer.sign(approve.data), certificate: signer.pem, signingToken: approve.signingToken }), 'ESF_SIGN_REQUEST_INVALID');
    expect(ops).toEqual([]);
    await esf.action(ctx, { action: 'APPROVE', ids: [add.id], signature: signer.sign(approve.data), certificate: signer.pem, signingToken: approve.signingToken });
    const confirm = await esf.actionData(ctx, { action: 'CONFIRM_REVOKE', ids: [rev.id] });
    await esf.action(ctx, { action: 'CONFIRM_REVOKE', ids: [rev.id], signature: signer.sign(confirm.data), certificate: signer.pem, signingToken: confirm.signingToken });
    expect(ops).toEqual(['approve', 'confirmRevoke']);
    expect((await prisma.esfInvoice.findUnique({ where: { id: add.id } }))!.status).toBe('DELIVERED');
    expect((await prisma.esfInvoice.findUnique({ where: { id: rev.id } }))!.status).toBe('REVOKED');
  });
});
