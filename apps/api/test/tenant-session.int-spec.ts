// FP-007 фаза 2: клиент в сессии берётся из БД, а не из токена или запроса; проводки и торговые документы
// не принимают справочник другого клиента — даже «общий» (без организации).
// Второй клиент живёт только внутри откатываемой транзакции, как в tenant-identity.int-spec.ts.
import { randomUUID } from 'crypto';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { OrgGuard } from '../src/modules/accounting/access/org-context';
import { DEFAULT_TENANT, ctxFor, defaultTenant, makeOrg, makeServices } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
type Tx = Prisma.TransactionClient;
class Rollback extends Error {}
const uid = () => randomUUID().slice(0, 8);

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000 })).rejects.toBeInstanceOf(Rollback);
}

/** Ошибка бухгалтерии с кодом; транзакция после неё продолжает работать. */
async function accRejected(tx: Tx, op: () => Promise<unknown>, code: string) {
  await tx.$executeRawUnsafe('SAVEPOINT fp007s');
  let error: any;
  try { await op(); } catch (e) { error = e; }
  await tx.$executeRawUnsafe(error ? 'ROLLBACK TO SAVEPOINT fp007s' : 'RELEASE SAVEPOINT fp007s');
  expect(error?.response?.code ?? error?.message).toBe(code);
}

function httpCtx(req: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => () => undefined, getClass: () => Object } as any;
}

beforeAll(async () => {
  await prisma.$connect();
  await defaultTenant(prisma);
  await s.chart.bootstrap();
});
afterAll(async () => prisma.$disconnect());

describe('FP-007: клиент в сессии', () => {
  it('JWT: клиент и организация — из БД, подмена в токене игнорируется; отключённый пользователь — 401', async () => {
    const ctx = await makeOrg(prisma);
    const strategy = new JwtStrategy(prisma);
    const user = await strategy.validate({ sub: ctx.userId, email: 'x', tenantId: 'чужой', organizationId: 'чужая', roles: [] });
    expect([user.tenantId, user.organizationId]).toEqual([DEFAULT_TENANT, ctx.organizationId]);
    await prisma.user.update({ where: { id: ctx.userId }, data: { isActive: false } });
    await expect(strategy.validate({ sub: ctx.userId })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(strategy.validate({ sub: randomUUID() })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('OrgGuard: контекст получает клиента из членства; организация другого клиента — 403', async () => {
    const ctx = await makeOrg(prisma);
    const guard = new OrgGuard(prisma, new Reflector());
    const req: any = { user: { sub: ctx.userId, organizationId: ctx.organizationId, tenantId: 'чужой' }, headers: {} };
    expect(await guard.canActivate(httpCtx(req))).toBe(true);
    expect(req.orgContext).toMatchObject({ tenantId: DEFAULT_TENANT, organizationId: ctx.organizationId });

    // Организация другого клиента: членства там быть не может (составной FK), значит доступ закрыт.
    // Guard читает через общий клиент БД, поэтому второй клиент здесь настоящий и удаляется в finally.
    const t2 = await prisma.tenant.create({ data: { name: `Клиент 2 ${uid()}` } });
    try {
      const foreign = await prisma.organization.create({ data: { tenantId: t2.id, name: `B ${uid()}` } });
      await expect(prisma.orgMembership.create({ data: { userId: ctx.userId, organizationId: foreign.id, role: 'owner' } })).rejects.toThrow(/Foreign key/);
      await expect(guard.canActivate(httpCtx({ user: { sub: ctx.userId, organizationId: ctx.organizationId }, headers: { 'x-organization-id': foreign.id } }))).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await prisma.organization.deleteMany({ where: { tenantId: t2.id } });
      await prisma.tenant.delete({ where: { id: t2.id } });
    }
  });
});

describe('FP-007: ссылки в учёте — только на справочник своего клиента и объекты своей организации', () => {
  /** Клиент T1 (по умолчанию): организации A и A2. Клиент T2: организация B. */
  async function world(tx: Tx) {
    const t2 = await tx.tenant.create({ data: { name: `Клиент 2 ${uid()}` } });
    const chart = await tx.accChart.findFirstOrThrow({ where: { code: 'KZ-TYPICAL' } });
    const org = async (tenantId: string, name: string) => {
      const o = await tx.organization.create({ data: { tenantId, name: `${name} ${uid()}` } });
      await tx.accPolicy.create({ data: { organizationId: o.id, validFrom: new Date('2020-01-01'), chartId: chart.id } });
      return o;
    };
    const a = await org(DEFAULT_TENANT, 'A');
    const a2 = await org(DEFAULT_TENANT, 'A2');
    const b = await org(t2.id, 'B');
    const uomT1 = await tx.uom.create({ data: { tenantId: DEFAULT_TENANT, name: 'шт', shortName: 'шт' } });
    const uomT2 = await tx.uom.create({ data: { tenantId: t2.id, name: 'шт', shortName: 'шт' } });
    return {
      a, a2, b,
      sharedCpT1: await tx.counterparty.create({ data: { tenantId: DEFAULT_TENANT, name: 'Общий T1' } }),
      sharedCpT2: await tx.counterparty.create({ data: { tenantId: t2.id, name: 'Общий T2' } }),
      privateCpA2: await tx.counterparty.create({ data: { organizationId: a2.id, name: 'Свой A2' } }),
      productT1: await tx.product.create({ data: { tenantId: DEFAULT_TENANT, name: 'Товар T1', uomId: uomT1.id } }),
      productT2: await tx.product.create({ data: { tenantId: t2.id, name: 'Товар T2', uomId: uomT2.id } }),
      storeA: await tx.store.create({ data: { organizationId: a.id, name: 'Склад A' } }),
      storeA2: await tx.store.create({ data: { organizationId: a2.id, name: 'Склад A2' } }),
    };
  }

  const entry = (postings: any[]) => ({ sourceType: 'TEST', sourceId: uid(), sourceVersion: 1, ruleCode: 'T', ruleVersion: '1', date: new Date('2026-10-15'), postings });
  const pair = (debit: any, amount = '100') => [{ ...debit, side: 'D', amount }, { account: '5030', side: 'C', amount }];

  it('проводка: общий контрагент своего клиента — да; другого клиента или чужой организации — REF_FOREIGN', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const ctxA = ctxFor(w.a.id, 'user-a', 'chief_accountant');
      await s.posting.writeEntry(tx, ctxA, entry(pair({ account: '1210', dims: { COUNTERPARTY: w.sharedCpT1.id } })));
      await accRejected(tx, () => s.posting.writeEntry(tx, ctxA, entry(pair({ account: '1210', dims: { COUNTERPARTY: w.sharedCpT2.id } }))), 'REF_FOREIGN');
      await accRejected(tx, () => s.posting.writeEntry(tx, ctxA, entry(pair({ account: '1210', dims: { COUNTERPARTY: w.privateCpA2.id } }))), 'REF_FOREIGN');
      // Аналитики проводок не имеют FK в БД — границу держит проверка кода, и клиент для неё берётся из контекста.
      await accRejected(tx, () => s.posting.writeEntry(tx, { ...ctxA, tenantId: 'не-тот' }, entry(pair({ account: '1210', dims: { COUNTERPARTY: w.sharedCpT1.id } }))), 'REF_FOREIGN');
    });
  });

  it('проводка: номенклатура другого клиента и склад другой организации — REF_FOREIGN', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const ctxA = ctxFor(w.a.id, 'user-a', 'chief_accountant');
      const goods = (productId: string, storeId: string) => entry(pair({ account: '1330', quantity: '1', dims: { PRODUCT: productId, STORE: storeId } }));
      await s.posting.writeEntry(tx, ctxA, goods(w.productT1.id, w.storeA.id));
      await accRejected(tx, () => s.posting.writeEntry(tx, ctxA, goods(w.productT2.id, w.storeA.id)), 'REF_FOREIGN');
      await accRejected(tx, () => s.posting.writeEntry(tx, ctxA, goods(w.productT1.id, w.storeA2.id)), 'REF_FOREIGN');
    });
  });

  it('торговый документ: «общий» контрагент или товар другого клиента — REF_FOREIGN', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const ctxA = ctxFor(w.a.id, 'user-a', 'chief_accountant');
      const validate = (input: any) => (s.trade as any).validateRefs(tx, ctxA, input);
      await validate({ docType: 'SUPPLY', date: '2026-10-15', counterpartyId: w.sharedCpT1.id, storeId: w.storeA.id, lines: [{ productId: w.productT1.id, qty: 1 }] });
      await accRejected(tx, () => validate({ docType: 'SUPPLY', date: '2026-10-15', counterpartyId: w.sharedCpT2.id }), 'REF_FOREIGN');
      await accRejected(tx, () => validate({ docType: 'SUPPLY', date: '2026-10-15', lines: [{ productId: w.productT2.id, qty: 1 }] }), 'REF_FOREIGN');
    });
  });
});
