import { PrismaService } from '../src/prisma/prisma.service';
import { AutomationService } from '../src/modules/accounting/automation/automation.service';
import { FilesService } from '../src/modules/accounting/files/files.service';
import { TradeDocumentsService } from '../src/modules/accounting/autopilot/trade-documents.service';
import { makeServices, makeOrg, makeTrade } from './accounting-helpers';
import * as os from 'os';
import * as path from 'path';

const prisma = new PrismaService();
const s = makeServices(prisma);
const automation = new AutomationService(prisma);
const trade = new TradeDocumentsService(prisma, (s.trade as any).autopilot, (s.trade as any).approvals, automation);
process.env.FILES_DATA_DIR = path.join(os.tmpdir(), `fp-files-${Date.now()}`);
const files = new FilesService(prisma);

describe('Сценарии и файлы', () => {
  afterAll(() => prisma.$disconnect());

  it('сценарий: заказ от 1000 ₸ → этап «Подтверждён» и задача ответственному; меньше — не срабатывает', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    await expect(automation.save(ctx, null, { name: 'x', event: 'DOC_CREATED', docType: 'CUSTOMER_ORDER', action: 'CREATE_TASK', params: {} })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NAME_REQUIRED' }) });
    await automation.save(ctx, null, { name: 'Крупный заказ', event: 'DOC_CREATED', docType: 'CUSTOMER_ORDER', condition: { minTotal: '1000' }, action: 'CREATE_TASK', params: { title: 'Позвонить {контрагент} по заказу {номер} на {сумма}', dueDays: 1, assignee: 'RESPONSIBLE' } });
    await automation.save(ctx, null, { name: 'Подтверждать', event: 'DOC_CREATED', docType: 'CUSTOMER_ORDER', condition: { minTotal: '1000' }, action: 'SET_ORDER_STAGE', params: { stage: 'CONFIRMED' } });
    const big = await trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '5', price: '300' }] });
    const small = await trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '300' }] });
    const tasks = await prisma.task.findMany({ where: { organizationId: ctx.organizationId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ documentId: big.id, assigneeId: ctx.userId });
    expect(tasks[0].title).toBe(`Позвонить ТОО Покупатель по заказу ${big.number} на 1500.00`);
    expect(((await trade.get(ctx, big.id)) as any).orderStatus).toBe('CONFIRMED');
    expect(((await trade.get(ctx, small.id)) as any).orderStatus).toBe('NEW');
    const rules = await automation.list(ctx);
    expect(rules.map((r) => r.runs)).toEqual([1, 1]);
  });

  it('файлы: прикрепить к документу, список, скачать, запрет чужой организации и опасных типов', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const doc = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '10' }] });
    const name = Buffer.from('Договор поставки.pdf', 'utf8').toString('latin1');
    const list = await files.upload(ctx, 'TRADE', doc.id, { originalname: name, mimetype: 'application/pdf', size: 4, buffer: Buffer.from('%PDF') });
    expect(list).toHaveLength(1);
    expect(list[0].fileName).toBe('Договор поставки.pdf');
    const d = await files.download(ctx, list[0].id);
    expect(d.data.toString()).toBe('%PDF');
    await expect(files.upload(ctx, 'TRADE', doc.id, { originalname: 'virus.exe', mimetype: 'application/x-msdownload', size: 3, buffer: Buffer.from('MZ!') })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FILE_TYPE' }) });
    const other = await makeOrg(prisma);
    await expect(files.download(other, list[0].id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await expect(files.list(other, 'TRADE', doc.id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NOT_FOUND' }) });
    await files.remove(ctx, list[0].id);
    expect(await files.list(ctx, 'TRADE', doc.id)).toHaveLength(0);
  });
});
