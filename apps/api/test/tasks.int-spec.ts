import { PrismaService } from '../src/prisma/prisma.service';
import { TasksService } from '../src/modules/accounting/tasks/tasks.service';
import { makeOrg, makeTrade, makeServices, ctxFor } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
const tasks = new TasksService(prisma);

describe('Задачи', () => {
  afterAll(() => prisma.$disconnect());
  it('создать себе и коллеге, срок и просрочка, связь с клиентом и документом, комментарий, выполнение, права', async () => {
    const ctx = await makeOrg(prisma);
    const t = await makeTrade(prisma, ctx, { vatPayer: false });
    const order = await s.trade.create(ctx, { docType: 'CUSTOMER_ORDER', date: '2026-10-02', counterpartyId: t.customer.id, storeId: t.s1.id, lines: [{ productId: t.goods.id, qty: '1', price: '10' }] });

    const a = await tasks.create(ctx, { title: 'Позвонить клиенту', dueAt: '2020-01-01', counterpartyId: t.customer.id, documentId: order.id });
    expect(a).toMatchObject({ assigneeId: ctx.userId, overdue: true, counterparty: { name: 'ТОО Покупатель' }, document: { number: order.number } });
    expect(await tasks.summary(ctx)).toMatchObject({ open: 1, overdue: 1 });
    expect((await tasks.list(ctx, { counterpartyId: t.customer.id, scope: 'all' })).map((x) => x.id)).toEqual([a.id]);

    const c = await tasks.comment(ctx, a.id, 'Не дозвонился, перезвонить завтра');
    expect(c.comments[0]).toMatchObject({ text: 'Не дозвонился, перезвонить завтра' });
    const d = await tasks.setDone(ctx, a.id, true);
    expect([d.done, d.overdue]).toEqual([true, false]);
    expect((await tasks.list(ctx, {})).length).toBe(0);
    expect((await tasks.list(ctx, { done: '1' })).length).toBe(1);

    await expect(tasks.create(ctx, { title: 'x' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TITLE_REQUIRED' }) });
    await expect(tasks.create(ctx, { title: 'Срок', dueAt: '31.12.2026' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_DATE' }) });
    const other = await makeOrg(prisma);
    await expect(tasks.create(ctx, { title: 'Чужому', assigneeId: other.userId })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_ASSIGNEE' }) });
    // чужая организация задачу не видит и не меняет
    await expect(tasks.setDone(other, a.id, false)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NOT_FOUND' }) });
    // посторонний сотрудник своей организации без прав руководителя — не меняет
    const u = await prisma.user.create({ data: { email: `w${Date.now()}@test.local`, passwordHash: 'x', firstName: 'Кладовщик', lastName: 'Тест', organizationId: ctx.organizationId } });
    await prisma.orgMembership.create({ data: { userId: u.id, organizationId: ctx.organizationId, role: 'ACCOUNTANT' } });
    const worker = ctxFor(ctx.organizationId, u.id, 'ACCOUNTANT', ctx.tenantId);
    await expect(tasks.setDone(worker, a.id, false)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FORBIDDEN' }) });
    const forWorker = await tasks.create(ctx, { title: 'Собрать заказ', assigneeId: u.id, dueAt: '2099-01-01T10:30' });
    expect(forWorker.dueAt.toISOString()).toBe('2099-01-01T05:30:00.000Z');
    expect((await tasks.setDone(worker, forWorker.id, true)).done).toBe(true);
  });
});
