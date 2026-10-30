import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from '../src/prisma/prisma.service';
import { EsfService } from '../src/modules/accounting/esf/esf.service';
import { esfDate, parseInvoice } from '../src/modules/accounting/esf/invoice-xml';
import { EsfSoapClient } from '../src/modules/accounting/esf/esf-soap.client';
import { makeServices, makeOrg, makeTrade, ctxFor } from './accounting-helpers';
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

/** Второй сотрудник той же организации (для «четырёх глаз»), по умолчанию — главный бухгалтер. */
async function colleague(ctx: { organizationId: string }, role = 'chief_accountant') {
  const user = await prisma.user.create({ data: { organizationId: ctx.organizationId, email: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, passwordHash: 'x', firstName: 'Второй', lastName: 'Сотрудник' } });
  await prisma.orgMembership.create({ data: { userId: user.id, organizationId: ctx.organizationId, role } });
  return ctxFor(ctx.organizationId, user.id, role);
}

/** Решение: предложить → утвердить (другим, если нужно) → данные для подписи. */
async function decided(ctx: any, kind: string, ids: string[], opts: { reason?: string; approver?: any } = {}) {
  const d = await esf.proposeDecision(ctx, { kind: kind as any, ids, reason: opts.reason, basis: 'Сверено с договором и перепиской' });
  await esf.approveDecision(opts.approver ?? ctx, d.id);
  return { d, data: await esf.decisionSigningData(ctx, d.id) };
}
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
    // Автоматика только предлагает поступление-основание; основанием его делает решение человека (FP-018).
    expect(row!.sourceDocId).toBeNull();
    expect(row!.suggestedSourceDocId).toBe(supply.id);
    // Техническое подтверждение получения — отдельно от юридического решения.
    expect(confirmed).toContain('<id>555</id>');
    expect(row!.status).toBe('DELIVERED');
    expect(row!.deliveryConfirmedAt).not.toBeNull();
    expect(row!.businessDecision).toBeNull();
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

  it('отзыв — решением: основание, другой утверждающий, подпись списка {id, причина} в формате SDK; повтор недоступен', async () => {
    const { ctx, inv } = await registeredSale();
    await expectCode(esf.proposeDecision(ctx, { kind: 'REVOKE', ids: [inv.id], basis: 'Сверено с договором' }), 'ESF_REASON');
    const d = await esf.proposeDecision(ctx, { kind: 'REVOKE', ids: [inv.id], reason: 'Ошибка в цене "А&Б"', basis: 'Письмо покупателя от 06.10' });
    await expectCode(esf.approveDecision(ctx, d.id), 'ESF_FOUR_EYES'); // автор не утверждает свой отзыв
    await esf.approveDecision(await colleague(ctx), d.id);
    const data = await esf.decisionSigningData(ctx, d.id);
    expect(data.data).toBe(`<signedContent><idsWithReasons><idWithReason><id>${inv.esfId}</id><reason>Ошибка в цене "А&amp;Б"</reason></idWithReason></idsWithReasons></signedContent>`);

    let req = '';
    esf.fetcher = fakeEsf({
      revokeInvoiceById: (b) => { req = b; return `<resultList><changeStatusResult><invoiceSummary><invoiceId>${inv.esfId}</invoiceId><invoiceStatus>WAITING_CUSTOMER_REVOKE_CONFIRMATION</invoiceStatus></invoiceSummary><isChanged>true</isChanged></changeStatusResult></resultList>`; },
      queryInvoiceSummaryById: () => `<invoiceSummaryList><invoiceSummary><invoiceId>${inv.esfId}</invoiceId><invoiceStatus>REVOKED</invoiceStatus></invoiceSummary></invoiceSummaryList>`,
      queryUpdates: () => `<lastEventDate>2026-10-23T10:00:00.000+05:00</lastEventDate><lastBlock>true</lastBlock><invoiceInfoList/>`,
    }).fetcher;
    const r = await esf.executeDecision(ctx, d.id, { signature: signer.sign(data.data), certificate: signer.pem, signingToken: data.signingToken });
    expect([r.status, r.changed]).toEqual(['EXECUTED', 1]);
    expect(req).toContain('<esf:revokeInvoiceByIdRequest>');
    expect(req).toContain(`<invoiceIdWithReason><id>${inv.esfId}</id><reason>Ошибка в цене "А&amp;Б"</reason></invoiceIdWithReason>`);
    let row = await prisma.esfInvoice.findUnique({ where: { id: inv.id } });
    expect(row).toMatchObject({ status: 'SENT', esfStatus: 'WAITING_CUSTOMER_REVOKE_CONFIRMATION', cancelReason: 'Ошибка в цене "А&Б"', businessDecision: 'REVOKE_REQUESTED' });
    // одно решение исполняется один раз
    await expectCode(esf.executeDecision(ctx, d.id, { signature: signer.sign(data.data), certificate: signer.pem, signingToken: data.signingToken }), 'ESF_DECISION_NOT_APPROVED');
    // покупатель подтвердил — опрос статуса доводит до REVOKED
    await esf.refresh(ctx);
    row = await prisma.esfInvoice.findUnique({ where: { id: inv.id } });
    expect(row!.status).toBe('REVOKED');
    // повторный отзыв недоступен
    await expectCode(esf.proposeDecision(ctx, { kind: 'REVOKE', ids: [inv.id], reason: 'x', basis: 'ещё раз' }), 'ESF_ACTION_NOT_ALLOWED');
  });

  it('входящие: подтверждение дополнительного ЭСФ и подтверждение отзыва — решениями (подпись списка id)', async () => {
    const { ctx } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021' });
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'S', iin: '123456789021', tin: '123456789021' } });
    const mk = (esfId: bigint, invoiceType: string, st: string) => prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', invoiceType, num: String(esfId), date: new Date('2026-10-10'), turnoverDate: new Date('2026-10-10'), status: st, esfStatus: st, esfId, body: '<x/>', bodyHash: 'x' } });
    const base = BigInt(Date.now()) * 100n;
    const add = await mk(base + 1n, 'ADDITIONAL_INVOICE', 'WAITING_CUSTOMER_CONFIRMATION');
    const rev = await mk(base + 2n, 'ORDINARY_INVOICE', 'WAITING_CUSTOMER_REVOKE_CONFIRMATION');
    await expectCode(esf.proposeDecision(ctx, { kind: 'APPROVE', ids: [rev.id], basis: 'Сверено с поставкой' }), 'ESF_ACTION_NOT_ALLOWED');
    const approve = await decided(ctx, 'APPROVE', [add.id]); // подтверждение — без «четырёх глаз» по умолчанию
    expect(approve.data.data).toBe(`<signedContent><ids><id>${base + 1n}</id></ids></signedContent>`);
    const ops: string[] = [];
    esf.fetcher = fakeEsf({
      approveInvoiceById: () => { ops.push('approve'); return `<resultList><changeStatusResult><invoiceSummary><invoiceId>${base + 1n}</invoiceId><invoiceStatus>DELIVERED</invoiceStatus></invoiceSummary><isChanged>true</isChanged></changeStatusResult></resultList>`; },
      revokeConfirmInvoiceById: () => { ops.push('confirmRevoke'); return `<resultList><changeStatusResult><invoiceSummary><invoiceId>${base + 2n}</invoiceId><invoiceStatus>REVOKED</invoiceStatus></invoiceSummary><isChanged>true</isChanged></changeStatusResult></resultList>`; },
    }).fetcher;
    await expectCode(esf.executeDecision(ctx, approve.d.id, { signature: 's', certificate: 'c', signingToken: approve.data.signingToken }), 'ESF_CERT');
    // неудачное исполнение закрывает решение — нужно новое (а не повтор того же)
    expect((await prisma.esfDecision.findUniqueOrThrow({ where: { id: approve.d.id } })).status).toBe('FAILED');
    const approve2 = await decided(ctx, 'APPROVE', [add.id]);
    const confirm = await decided(ctx, 'CONFIRM_REVOKE', [rev.id]);
    // токен одного решения не подходит для другого
    await expectCode(esf.executeDecision(ctx, confirm.d.id, { signature: signer.sign(approve2.data.data), certificate: signer.pem, signingToken: approve2.data.signingToken }), 'ESF_SIGN_REQUEST_INVALID');
    expect(ops).toEqual([]);
    await esf.executeDecision(ctx, approve2.d.id, { signature: signer.sign(approve2.data.data), certificate: signer.pem, signingToken: approve2.data.signingToken });
    const confirm2 = await decided(ctx, 'CONFIRM_REVOKE', [rev.id]);
    await esf.executeDecision(ctx, confirm2.d.id, { signature: signer.sign(confirm2.data.data), certificate: signer.pem, signingToken: confirm2.data.signingToken });
    expect(ops).toEqual(['approve', 'confirmRevoke']);
    expect(await prisma.esfInvoice.findUnique({ where: { id: add.id } })).toMatchObject({ status: 'DELIVERED', businessDecision: 'APPROVED' });
    expect(await prisma.esfInvoice.findUnique({ where: { id: rev.id } })).toMatchObject({ status: 'REVOKED', businessDecision: 'REVOKE_CONFIRMED' });
  });
});

describe('FP-017: отправка и сверка результата — потерянный ответ → UNKNOWN, без слепой повторной отправки', () => {
  const soapFault = (code: string, text: string) =>
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>${code}</faultcode><faultstring>${text}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;

  /** Две готовые к отправке ЭСФ, открытая сессия, подписи по запросу на подпись. */
  async function readyToSend() {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021', vatRegistrationDate: '2020-01-15', transportTypeCode: '30', defaultGoodsOrigin: '5' });
    const sale1 = await stockAndSell(ctx, t, '2026-10-05');
    const sale2 = await s.trade.create(ctx, { docType: 'DEMAND', date: '2026-10-06', counterpartyId: t.customer.id, storeId: t.s1.id, status: 'POSTED', lines: [{ productId: t.service.id, qty: '1', price: '580' }] });
    const i1 = await esf.prepare(ctx, sale1.id);
    const i2 = await esf.prepare(ctx, sale2.id);
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'S-17', iin: '123456789021', tin: '123456789021' } });
    const sign = async () => {
      const sd = await esf.signData(ctx, [i1.id, i2.id]);
      return { certificate: signer.pem, items: sd.items.map((i) => ({ id: i.id, signature: signer.sign(i.body), signingToken: i.signingToken })) };
    };
    const row = (id: string) => prisma.esfInvoice.findUniqueOrThrow({ where: { id } });
    const audits = (action: string) => prisma.auditLog.findMany({ where: { organizationId: ctx.organizationId, action } });
    return { ctx, i1, i2, sign, row, audits };
  }

  /** Поддельная ИС ЭСФ с управляемым поведением syncInvoice и сверки по ключу. */
  function stand(opts: { sync: (body: string) => string | Error | { fault: string } | Promise<string>; byKey?: (body: string) => string }) {
    const calls: { op: string; body: string }[] = [];
    const fetcher = async (_url: string, init: any) => {
      const op = /esf:(\w+)Request/.exec(init.body)?.[1] ?? '?';
      calls.push({ op, body: init.body });
      const wrapOk = (inner: string) => ({ status: 200, text: async () => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:${op}Response xmlns:ns2="esf">${inner}</ns2:${op}Response></soap:Body></soap:Envelope>` });
      if (op === 'syncInvoice') {
        const r = await opts.sync(init.body);
        if (r instanceof Error) throw r;
        if (typeof r === 'object') return { status: 500, text: async () => r.fault };
        return wrapOk(r);
      }
      if (op === 'queryInvoiceSummaryByKey') return wrapOk(opts.byKey?.(init.body) ?? '<invoiceSummaryList/>');
      if (op === 'queryInvoiceSummaryById') return wrapOk('<invoiceSummaryList/>');
      if (op === 'queryUpdates') return wrapOk('<lastEventDate>2026-10-23T10:00:00.000+05:00</lastEventDate><lastBlock>true</lastBlock><invoiceInfoList/>');
      return wrapOk('');
    };
    return { fetcher, calls, syncCalls: () => calls.filter((c) => c.op === 'syncInvoice').length };
  }

  it('обрыв связи во время отправки → UNKNOWN; повторно подписать и отправить нельзя', async () => {
    const { ctx, i1, i2, sign, row } = await readyToSend();
    const st = stand({ sync: () => new Error('socket hang up') });
    esf.fetcher = st.fetcher;
    await expectCode(esf.upload(ctx, await sign()), 'ESF_NETWORK');
    for (const id of [i1.id, i2.id]) expect(await row(id)).toMatchObject({ status: 'UNKNOWN', esfId: null });
    expect(((await row(i1.id)).errors as any[])[0].errorCode).toBe('OUTCOME_UNKNOWN');
    await expectCode(esf.signData(ctx, [i1.id]), 'ESF_STATUS');
    const again = await esf.prepare(ctx, (await row(i1.id)).sourceDocId!);
    expect(again).toMatchObject({ id: i1.id, status: 'UNKNOWN' }); // не пересобирается и не получает новый номер
    await expectCode(esf.discard(ctx, i1.id), 'ESF_STATUS');
    expect(st.syncCalls()).toBe(1);
  });

  it('неразборчивый ответ или общая SOAP-ошибка → UNKNOWN (не READY)', async () => {
    const { ctx, i1, sign, row } = await readyToSend();
    esf.fetcher = stand({ sync: () => ({ fault: soapFault('soap:Server', 'Internal error') }) }).fetcher;
    await expectCode(esf.upload(ctx, await sign()), 'ESF_FAULT');
    expect((await row(i1.id)).status).toBe('UNKNOWN');
  });

  it('закрытая сессия — запрос не обрабатывался: ЭСФ снова READY, повтор после входа возможен', async () => {
    const { ctx, i1, i2, sign, row, audits } = await readyToSend();
    esf.fetcher = stand({ sync: () => ({ fault: soapFault('soap:Server', 'Session closed') }) }).fetcher;
    await expectCode(esf.upload(ctx, await sign()), 'ESF_SESSION_CLOSED');
    for (const id of [i1.id, i2.id]) expect(await row(id)).toMatchObject({ status: 'READY', sentAt: null, signature: null });
    expect(await audits('ESF_SEND_NOT_PROCESSED')).toHaveLength(1);
  });

  it('ИС ЭСФ не вернула результат по одному ЭСФ → только он UNKNOWN', async () => {
    const { ctx, i1, i2, sign, row } = await readyToSend();
    esf.fetcher = stand({ sync: () => `<acceptedSet><standardResponse><id>7001</id><num>${i1.num}</num><date>${esfDate(new Date())}</date></standardResponse></acceptedSet>` }).fetcher;
    const up = await esf.upload(ctx, await sign());
    expect(up).toMatchObject({ accepted: 1, declined: 0, unknown: 1 });
    expect(await row(i1.id)).toMatchObject({ status: 'SENT', esfStatus: 'IN_QUEUE' });
    expect((await row(i2.id)).status).toBe('UNKNOWN');
  });

  it('две параллельные отправки одних и тех же ЭСФ → в ИС ЭСФ уходит одна', async () => {
    const { ctx, sign } = await readyToSend();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const st = stand({ sync: () => '<acceptedSet/>' });
    const slow = async (url: string, init: any) => { if (init.body.includes('syncInvoiceRequest')) await gate; return st.fetcher(url, init); };
    esf.fetcher = slow;
    const payload = await sign();
    const first = esf.upload(ctx, payload);
    await new Promise((r) => setTimeout(r, 50));
    await expectCode(esf.upload(ctx, payload), 'ESF_STATUS');
    release();
    await first;
    expect(st.syncCalls()).toBe(1);
  });

  it('процесс упал после захвата: истёкший SENDING → UNKNOWN; свежий SENDING не трогается', async () => {
    const { ctx, i1, i2, row, audits } = await readyToSend();
    await prisma.esfInvoice.update({ where: { id: i1.id }, data: { status: 'SENDING', sentAt: new Date(Date.now() - EsfService.SEND_LEASE_MS - 1000) } });
    await prisma.esfInvoice.update({ where: { id: i2.id }, data: { status: 'SENDING', sentAt: new Date() } });
    await esf.recoverStaleSending(ctx.organizationId);
    expect((await row(i1.id)).status).toBe('UNKNOWN');
    expect(((await row(i1.id)).errors as any[])[0].errorCode).toBe('RECOVERED_UNKNOWN');
    expect((await row(i2.id)).status).toBe('SENDING');
    expect(await audits('ESF_SEND_RECOVERED_UNKNOWN')).toHaveLength(1);
  });

  it('запоздавший ответ после восстановления не применяется (fencing по метке захвата)', async () => {
    const { ctx, i1, sign, row } = await readyToSend();
    esf.fetcher = stand({
      sync: async () => {
        // пока ИС ЭСФ «думает», другой процесс признал отправку зависшей
        await prisma.esfInvoice.updateMany({ where: { id: i1.id }, data: { status: 'UNKNOWN' } });
        return `<acceptedSet><standardResponse><id>7002</id><num>${i1.num}</num><date>${esfDate(new Date())}</date></standardResponse></acceptedSet>`;
      },
    }).fetcher;
    const up = await esf.upload(ctx, await sign());
    const r1 = up.items.find((x: any) => x.id === i1.id);
    expect(r1.fenced).toBe(true);
    expect(await row(i1.id)).toMatchObject({ status: 'UNKNOWN', esfId: null });
  });

  it('сверка по ключу (дата+номер) находит принятый ЭСФ → SENT с id; запрос сверки доказуемо по ключу', async () => {
    const { ctx, i1, i2, sign, row, audits } = await readyToSend();
    esf.fetcher = stand({ sync: () => new Error('timeout') }).fetcher;
    await expectCode(esf.upload(ctx, await sign()), 'ESF_NETWORK');
    const d = esfDate((await row(i1.id)).date);
    const st = stand({ sync: () => '', byKey: () => `<invoiceSummaryList><invoiceSummary><invoiceId>8001</invoiceId><invoiceStatus>CREATED</invoiceStatus><num>${i1.num}</num><date>${d}</date></invoiceSummary><invoiceSummary><invoiceId>8999</invoiceId><num>${i2.num}</num><date>01.01.2020</date></invoiceSummary></invoiceSummaryList>` });
    esf.fetcher = st.fetcher;
    await esf.refresh(ctx);
    const lookup = st.calls.find((c) => c.op === 'queryInvoiceSummaryByKey')!;
    expect(lookup.body).toContain(`<invoiceKey><date>${d}</date><num>${i1.num}</num></invoiceKey>`);
    expect(lookup.body).toContain('<direction>OUTBOUND</direction>');
    expect(await row(i1.id)).toMatchObject({ status: 'SENT', esfId: 8001n });
    // совпал номер, но не дата — это не наш документ
    expect(await row(i2.id)).toMatchObject({ status: 'UNKNOWN', esfId: null });
    expect(await audits('ESF_RECONCILE_FOUND')).toHaveLength(1);
    expect(st.syncCalls()).toBe(0); // сверка никогда не отправляет повторно
  });

  it('не найдено → остаётся UNKNOWN; повтор только явным решением после «тихого» срока, с причиной и в журнале', async () => {
    const { ctx, i1, sign, row, audits } = await readyToSend();
    esf.fetcher = stand({ sync: () => new Error('timeout') }).fetcher;
    await expectCode(esf.upload(ctx, await sign()), 'ESF_NETWORK');
    esf.fetcher = stand({ sync: () => '' }).fetcher;
    await esf.refresh(ctx); // сразу после отправки — «не найдено» ещё ничего не доказывает
    expect((await row(i1.id)).status).toBe('UNKNOWN');
    expect((await audits('ESF_RECONCILE_NOT_FOUND')).length).toBeGreaterThan(0);
    await expectCode(esf.releaseUnknown(ctx, i1.id, 'проверил в ИС ЭСФ'), 'ESF_RECONCILE_REQUIRED');

    // прошло больше тихого срока, сверка снова не нашла
    await prisma.esfInvoice.update({ where: { id: i1.id }, data: { sentAt: new Date(Date.now() - EsfService.RECONCILE_QUIET_MS - 60_000) } });
    await esf.refresh(ctx);
    await expectCode(esf.releaseUnknown(ctx, i1.id, ''), 'ESF_REASON');
    const rel = await esf.releaseUnknown(ctx, i1.id, 'сверка не нашла, ИС ЭСФ проверена вручную');
    expect(rel.status).toBe('READY');
    const log = await audits('ESF_UNKNOWN_RELEASED');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ userId: ctx.userId, reason: 'сверка не нашла, ИС ЭСФ проверена вручную' });
    // теперь можно подписать заново
    expect((await esf.signData(ctx, [i1.id])).items).toHaveLength(1);
  });
});

describe('FP-018: решения по исправлению, дополнению и отзыву', () => {
  /** Входящий ЭСФ в нужном состоянии + открытая сессия. */
  async function inbound(invoiceType = 'ADDITIONAL_INVOICE', st = 'WAITING_CUSTOMER_CONFIRMATION', extra: any = {}) {
    const { ctx, t } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021' });
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'S', iin: '123456789021', tin: '123456789021' } });
    const esfId = BigInt(Date.now()) * 100n + BigInt(Math.floor(Math.random() * 100));
    const inv = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', invoiceType, num: String(esfId), date: new Date('2026-10-10'), turnoverDate: new Date('2026-10-10'), status: st, esfStatus: st, esfId, body: '<x/>', bodyHash: 'x', lastUpdateAt: new Date('2026-10-10T00:00:00Z'), ...extra } });
    return { ctx, t, inv };
  }

  it('техническое подтверждение не является согласием: импорт не утверждает исправленный/дополнительный ЭСФ сам', async () => {
    const { ctx } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021' });
    await prisma.esfSession.create({ data: { organizationId: ctx.organizationId, environment: 'TEST', sessionId: 'S', iin: '123456789021', tin: '123456789021' } });
    const body = `<?xml version="1.0" encoding="UTF-8"?><v2:invoice xmlns:a="abstractInvoice.esf" xmlns:v2="v2.esf"><date>12.10.2026</date><invoiceType>ADDITIONAL_INVOICE</invoiceType><num>88</num><operatorFullname>X</operatorFullname><relatedInvoice><date>02.10.2026</date><num>77</num><registrationNumber>ESF-987654321098-20261002-0077</registrationNumber></relatedInvoice><turnoverDate>12.10.2026</turnoverDate><customers><customer><countryCode>KZ</countryCode><name>Мы</name><tin>123456789021</tin></customer></customers><deliveryTerm><hasContract>false</hasContract><paymentForm>NON_CASH</paymentForm></deliveryTerm><productSet><currencyCode>KZT</currencyCode><products><product><catalogTruId>1</catalogTruId><description>Яблоки</description><ndsAmount>-160.00</ndsAmount><ndsRate>16</ndsRate><priceWithTax>-1160.00</priceWithTax><priceWithoutTax>-1000.00</priceWithoutTax><truOriginCode>4</truOriginCode><turnoverSize>-1000.00</turnoverSize></product></products><totalExciseAmount>0</totalExciseAmount><totalNdsAmount>-160.00</totalNdsAmount><totalPriceWithTax>-1160.00</totalPriceWithTax><totalPriceWithoutTax>-1000.00</totalPriceWithoutTax><totalTurnoverSize>-1000.00</totalTurnoverSize></productSet><sellers><seller><name>ТОО Поставщик</name><tin>987654321098</tin></seller></sellers></v2:invoice>`;
    const original = await prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', invoiceType: 'ORDINARY_INVOICE', num: '77', date: new Date('2026-10-02'), turnoverDate: new Date('2026-10-01'), sellerTin: '987654321098', status: 'DELIVERED', esfStatus: 'DELIVERED', esfId: BigInt(Date.now()) * 10n, registrationNumber: 'ESF-987654321098-20261002-0077', body: '<x/>', bodyHash: 'x' } });
    const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ops: string[] = [];
    const newId = BigInt(Date.now()) * 10n + 7n;
    esf.fetcher = fakeEsf({
      queryUpdates: () => `<lastEventDate>2026-10-23T10:00:00.000+05:00</lastEventDate><lastInvoiceId>${newId}</lastInvoiceId><lastBlock>true</lastBlock><invoiceInfoList><invoiceInfo><invoiceBody>${esc}</invoiceBody><invoiceId>${newId}</invoiceId><registrationNumber>ESF-987654321098-20261012-0088</registrationNumber><inputDate>2026-10-12T10:00:00+05:00</inputDate><lastUpdateDate>2026-10-12T10:00:00+05:00</lastUpdateDate><signatureValid>true</signatureValid><invoiceStatus>WAITING_CUSTOMER_CONFIRMATION</invoiceStatus><version>InvoiceV2</version><signature>x</signature><signatureType>COMPANY</signatureType><certificate>x</certificate></invoiceInfo></invoiceInfoList>`,
      confirmInvoiceById: () => { ops.push('confirm'); return '<invoiceSummaryList/>'; },
      approveInvoiceById: () => { ops.push('approve'); return '<resultList/>'; },
      declineInvoiceById: () => { ops.push('decline'); return '<resultList/>'; },
    }).fetcher;
    await esf.refresh(ctx);
    const add = await prisma.esfInvoice.findFirstOrThrow({ where: { organizationId: ctx.organizationId, esfId: newId } });
    expect(ops).toEqual([]); // ждёт подтверждения — ни согласия, ни отказа без человека
    expect(add).toMatchObject({ status: 'WAITING_CUSTOMER_CONFIRMATION', businessDecision: null, relatedInvoiceId: original.id }); // цепочка к исходному
    expect(await prisma.esfDecision.count({ where: { organizationId: ctx.organizationId } })).toBe(0);
  });

  it('основание обязательно; отклонение — с причиной; второе решение по тому же ЭСФ, пока первое в работе, — нельзя', async () => {
    const { ctx, inv } = await inbound();
    await expectCode(esf.proposeDecision(ctx, { kind: 'APPROVE', ids: [inv.id], basis: '' }), 'ESF_BASIS');
    await expectCode(esf.proposeDecision(ctx, { kind: 'DECLINE', ids: [inv.id], basis: 'Сверка с поставкой' }), 'ESF_REASON');
    const d = await esf.proposeDecision(ctx, { kind: 'DECLINE', ids: [inv.id], reason: 'Цены не согласованы', basis: 'Договор № 5, п. 3' });
    expect(d).toMatchObject({ status: 'PROPOSED', fourEyes: true, dueAt: null, dueSource: 'NOT_CONFIGURED', requiredPermission: 'acc.esf.approve' });
    await expectCode(esf.proposeDecision(ctx, { kind: 'APPROVE', ids: [inv.id], basis: 'Сверено' }), 'ESF_DECISION_PENDING');
    await esf.rejectDecision(ctx, d.id, 'Передумали, нужна сверка');
    expect((await esf.proposeDecision(ctx, { kind: 'APPROVE', ids: [inv.id], basis: 'Сверено с поставкой' })).status).toBe('PROPOSED');
  });

  it('роль: бухгалтер предлагает, но не утверждает; отклонение утверждает другой сотрудник', async () => {
    const { ctx, inv } = await inbound();
    const accountant = await colleague(ctx, 'accountant');
    const d = await esf.proposeDecision(accountant, { kind: 'DECLINE', ids: [inv.id], reason: 'Не наш товар', basis: 'Накладная не поступала' });
    await expectCode(esf.approveDecision(accountant, d.id), 'FORBIDDEN');
    await esf.approveDecision(ctx, d.id); // главный бухгалтер, не автор
    expect((await prisma.esfDecision.findUniqueOrThrow({ where: { id: d.id } })).decidedBy).toBe(ctx.userId);
  });

  it('без утверждения не подписать и не исполнить; утверждение действует 24 часа', async () => {
    const { ctx, inv } = await inbound();
    const d = await esf.proposeDecision(ctx, { kind: 'APPROVE', ids: [inv.id], basis: 'Сверено с поставкой' });
    await expectCode(esf.decisionSigningData(ctx, d.id), 'ESF_DECISION_NOT_APPROVED');
    await expectCode(esf.executeDecision(ctx, d.id, { signature: 's', certificate: 'c' }), 'ESF_DECISION_NOT_APPROVED');
    await esf.approveDecision(ctx, d.id);
    await prisma.esfDecision.update({ where: { id: d.id }, data: { approvalExpiresAt: new Date(Date.now() - 1000) } });
    await expectCode(esf.decisionSigningData(ctx, d.id), 'ESF_DECISION_EXPIRED');
  });

  it('ЭСФ изменился после утверждения — решение устарело и не исполняется', async () => {
    const { ctx, inv } = await inbound();
    const { d, data } = await decided(ctx, 'APPROVE', [inv.id]);
    let called = false;
    esf.fetcher = fakeEsf({ approveInvoiceById: () => { called = true; return '<resultList/>'; } }).fetcher;
    await prisma.esfInvoice.update({ where: { id: inv.id }, data: { esfStatus: 'DECLINED', status: 'DECLINED' } }); // например, отклонил кто-то в портале
    await expectCode(esf.executeDecision(ctx, d.id, { signature: signer.sign(data.data), certificate: signer.pem, signingToken: data.signingToken }), 'ESF_DECISION_STALE');
    expect(called).toBe(false);
    expect((await prisma.esfDecision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('STALE');
  });

  it('срок — из правила методолога; просрочка видна, но ничего не решается автоматически', async () => {
    const { ctx, inv } = await inbound();
    await expectCode(esf.updateSettings(ctx, { decisionRules: { DECLINE: { deadlineDays: 0 } } }), 'ESF_RULE');
    await esf.updateSettings(ctx, { decisionRules: { APPROVE: { deadlineDays: 5 } } });
    const d = await esf.proposeDecision(ctx, { kind: 'APPROVE', ids: [inv.id], basis: 'Сверено с поставкой' });
    expect([d.dueSource, d.dueAt!.toISOString()]).toEqual(['RULE', '2026-10-15T00:00:00.000Z']); // lastUpdateAt + 5 дней
    const list = await esf.decisions(ctx);
    expect(list.find((x) => x.id === d.id)).toMatchObject({ overdue: true, status: 'PROPOSED' });
    await esf.tick();
    expect((await prisma.esfDecision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('PROPOSED');
    expect((await prisma.esfInvoice.findUniqueOrThrow({ where: { id: inv.id } })).businessDecision).toBeNull();
  });

  it('основание входящего: предложение автоматики становится основанием только утверждённым решением', async () => {
    const { ctx, t, inv } = await inbound('ORDINARY_INVOICE', 'DELIVERED');
    const supply = await s.trade.create(ctx, { docType: 'SUPPLY', date: '2026-10-10', counterpartyId: t.supplier.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '100' }], status: 'POSTED' });
    const other = await setupOrg();
    const foreign = await s.trade.create(other.ctx, { docType: 'SUPPLY', date: '2026-10-10', counterpartyId: other.t.supplier.id, storeId: other.t.s1.id, lines: [{ productId: other.t.goods.id, qty: '1', price: '100' }], status: 'POSTED' });
    await expectCode(esf.proposeDecision(ctx, { kind: 'LINK_BASIS', ids: [inv.id], basisDocId: foreign.id, basis: 'Совпадает сумма' }), 'REF_FOREIGN');
    const { d } = await (async () => {
      const p = await esf.proposeDecision(ctx, { kind: 'LINK_BASIS', ids: [inv.id], basisDocId: supply.id, basis: 'Совпадает накладная № 12' });
      await expectCode(esf.decisionSigningData(ctx, p.id), 'ESF_DECISION_NOT_APPROVED');
      await esf.approveDecision(ctx, p.id);
      return { d: p };
    })();
    expect((await prisma.esfInvoice.findUniqueOrThrow({ where: { id: inv.id } })).sourceDocId).toBeNull();
    const r = await esf.executeDecision(ctx, d.id);
    expect(r.status).toBe('EXECUTED');
    expect(await prisma.esfInvoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ sourceDocId: supply.id, businessDecision: 'BASIS_LINKED' });
    expect(await prisma.auditLog.count({ where: { entity: 'esf_decision', entityId: d.id } })).toBe(3); // предложено, утверждено, исполнено
  });
});

describe('FP-020: рабочее место — списки, фильтры, карточка', () => {
  async function org3() {
    const { ctx } = await setupOrg();
    await esf.updateSettings(ctx, { signerIin: '123456789021' });
    const base = BigInt(Date.now()) * 100n;
    const mk = (n: number, d: Record<string, unknown>) => prisma.esfInvoice.create({ data: { organizationId: ctx.organizationId, direction: 'INBOUND', invoiceType: 'ORDINARY_INVOICE', num: String(base + BigInt(n)), date: new Date('2026-10-10'), turnoverDate: new Date('2026-10-10'), status: 'DELIVERED', esfStatus: 'DELIVERED', esfId: base + BigInt(n), body: '<x/>', bodyHash: 'x', ...d } });
    const plain = await mk(1, {});
    const waiting = await mk(2, { invoiceType: 'ADDITIONAL_INVOICE', status: 'WAITING_CUSTOMER_CONFIRMATION', esfStatus: 'WAITING_CUSTOMER_CONFIRMATION', relatedInvoiceId: plain.id });
    const unknown = await mk(3, { direction: 'OUTBOUND', status: 'UNKNOWN', esfStatus: null, sentAt: new Date(Date.now() - 3600_000) });
    const rejected = await mk(4, { direction: 'OUTBOUND', status: 'REJECTED', errors: [{ errorCode: 'TIN_NOT_FOUND', text: 'нет' }], date: new Date('2026-09-01') });
    // Доставлен, но с замечаниями ИС ЭСФ — тоже во вкладке «Ошибки».
    const warned = await mk(5, { errors: [{ errorCode: 'W_ADDRESS', text: 'адрес' }] });
    return { ctx, mk, plain, waiting, unknown, rejected, warned };
  }
  const ids = (r: any) => r.items.map((i: any) => i.id);

  it('«Требуют решения» и «Ошибки»; фильтры по периоду, коду ошибки, виду', async () => {
    const w = await org3();
    expect(ids(await esf.list(w.ctx, { view: 'NEEDS_DECISION' })).sort()).toEqual([w.waiting.id, w.unknown.id].sort());
    expect(ids(await esf.list(w.ctx, { view: 'ERRORS' })).sort()).toEqual([w.unknown.id, w.rejected.id, w.warned.id].sort());
    expect(ids(await esf.list(w.ctx, { errorCode: 'TIN_NOT_FOUND' }))).toEqual([w.rejected.id]);
    expect(ids(await esf.list(w.ctx, { from: '2026-10-01', to: '2026-10-31' }))).not.toContain(w.rejected.id);
    expect(ids(await esf.list(w.ctx, { invoiceType: 'ADDITIONAL_INVOICE' }))).toEqual([w.waiting.id]);
  });

  it('карточка: XML как есть, форма, цепочка в обе стороны, история; UNKNOWN — повтор только после сверки', async () => {
    const w = await org3();
    const card = await esf.get(w.ctx, w.waiting.id);
    expect(card.chain.original?.id).toBe(w.plain.id);
    expect(card.body).toBe('<x/>');
    expect(card.parseError).toMatch(/не соответствует формату ЭСФ/); // испорченное тело не скрывается — видна причина
    expect(card.parseErrorDetail).toBeTruthy();
    expect((await esf.get(w.ctx, w.plain.id)).chain.corrections.map((c: any) => c.id)).toEqual([w.waiting.id]);
    const d = await esf.proposeDecision(w.ctx, { kind: 'APPROVE', ids: [w.waiting.id], basis: 'Сверено с поставкой' });
    // Решение по другому ЭСФ в карточку не попадает.
    const other = await w.mk(6, { invoiceType: 'ADDITIONAL_INVOICE', relatedInvoiceId: w.plain.id, status: 'WAITING_CUSTOMER_CONFIRMATION', esfStatus: 'WAITING_CUSTOMER_CONFIRMATION' });
    await esf.proposeDecision(w.ctx, { kind: 'APPROVE', ids: [other.id], basis: 'Другой' });
    expect((await esf.get(w.ctx, w.waiting.id)).decisions.map((x: any) => x.id)).toEqual([d.id]);
    expect((await esf.get(w.ctx, w.waiting.id)).timeline.map((x: any) => x.action)).toContain('ESF_DECISION_PROPOSED');

    const u = await esf.get(w.ctx, w.unknown.id);
    expect(u.unknown).toMatchObject({ canRelease: false });
    // Сверка внутри «тихого» периода (ИС ЭСФ могла ещё не зарегистрировать ЭСФ) — не доказательство.
    await prisma.auditLog.create({ data: { organizationId: w.ctx.organizationId, action: 'ESF_RECONCILE_NOT_FOUND', entity: 'esf_invoice', entityId: w.unknown.id, ts: new Date(w.unknown.sentAt!.getTime() + 60_000) } });
    expect((await esf.get(w.ctx, w.unknown.id)).unknown).toMatchObject({ canRelease: false });
    await prisma.auditLog.create({ data: { organizationId: w.ctx.organizationId, action: 'ESF_RECONCILE_NOT_FOUND', entity: 'esf_invoice', entityId: w.unknown.id } });
    expect((await esf.get(w.ctx, w.unknown.id)).unknown).toMatchObject({ canRelease: true });
  });
});
