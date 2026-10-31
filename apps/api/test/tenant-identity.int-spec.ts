// FP-007 acceptance: два клиента (tenant) и две организации не видят и не связывают чужие объекты —
// здесь уровень БД: составные ключи и FK держат границу даже при ошибке прикладного фильтра.
// Второй клиент живёт только внутри транзакции, которая откатывается: тестовая БД остаётся с одним клиентом.
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEFAULT_TENANT, defaultTenant, makeServices } from './accounting-helpers';

const prisma = new PrismaService();
const s = makeServices(prisma);
type Tx = Prisma.TransactionClient;

class Rollback extends Error {}

/** Сценарий в транзакции, которая всегда откатывается. */
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(
    prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000 }),
  ).rejects.toBeInstanceOf(Rollback);
}

/** Операция должна быть отклонена БД; транзакция после отказа продолжает работать (savepoint). */
async function rejected(tx: Tx, op: () => Promise<unknown>, match: RegExp = /Foreign key constraint|violates foreign key/) {
  await tx.$executeRawUnsafe('SAVEPOINT fp007');
  let error: any;
  try {
    await op();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe(error ? 'ROLLBACK TO SAVEPOINT fp007' : 'RELEASE SAVEPOINT fp007');
  expect(error).toBeDefined();
  expect(String(error?.message)).toMatch(match);
}

const uid = () => randomUUID().slice(0, 8);

/** Два клиента: T1 (по умолчанию) с организациями A и A2, T2 с организацией B. У каждого свой справочник. */
async function world(tx: Tx) {
  const t2 = await tx.tenant.create({ data: { name: `Клиент 2 ${uid()}` } });
  const a = await tx.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `A ${uid()}` } });
  const a2 = await tx.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `A2 ${uid()}` } });
  const b = await tx.organization.create({ data: { tenantId: t2.id, name: `B ${uid()}` } });
  const catalog = async (tenantId: string, orgId: string) => {
    const uom = await tx.uom.create({ data: { tenantId, name: 'штука', shortName: 'шт' } });
    const product = await tx.product.create({ data: { tenantId, name: `Товар ${uid()}`, uomId: uom.id } }); // общий справочник клиента
    const counterparty = await tx.counterparty.create({ data: { tenantId, name: `Контрагент ${uid()}` } });
    const priceType = await tx.priceType.create({ data: { tenantId, name: 'Розничная' } });
    const store = await tx.store.create({ data: { organizationId: orgId, name: `Склад ${uid()}` } });
    return { uom, product, counterparty, priceType, store };
  };
  return { t2, a, a2, b, t1c: await catalog(DEFAULT_TENANT, a.id), t2c: await catalog(t2.id, b.id), a2store: await tx.store.create({ data: { organizationId: a2.id, name: `Склад A2 ${uid()}` } }) };
}

beforeAll(async () => {
  await prisma.$connect();
  await defaultTenant(prisma);
  await s.chart.bootstrap();
});
afterAll(async () => prisma.$disconnect());

describe('FP-007: клиент над организацией', () => {
  it('tenant_id организации и строк справочника выводится из родителя, а без клиента запись не создаётся', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const store = await tx.store.findUniqueOrThrow({ where: { id: w.t2c.store.id } });
      expect(store.tenantId).toBe(w.t2.id); // от организации B
      const doc = await tx.document.create({
        data: { docType: 'SUPPLY', date: new Date(), organizationId: w.b.id, lines: { create: [{ lineNo: 1, productId: w.t2c.product.id, qty: 1 }] } },
        include: { lines: true },
      });
      expect([doc.tenantId, doc.lines[0].tenantId]).toEqual([w.t2.id, w.t2.id]);
      // Клиентов два, а у общего справочника нет ни клиента, ни организации — неизвестно, чей он: отказ.
      await rejected(tx, () => tx.counterparty.create({ data: { name: 'ничей' } }), /Null constraint|null value|tenant_id/);
      // Контекст сессии (SET LOCAL) задаёт клиента явно.
      await tx.$executeRawUnsafe(`SELECT set_config('flowpos.tenant_id', '${w.t2.id}', true)`);
      expect((await tx.counterparty.create({ data: { name: 'из контекста' } })).tenantId).toBe(w.t2.id);
    });
  });

  it('пользователь и членство — только в организациях своего клиента', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await rejected(tx, () => tx.user.create({ data: { tenantId: DEFAULT_TENANT, organizationId: w.b.id, email: `x-${uid()}@t.local`, passwordHash: 'x', firstName: 'Х', lastName: 'Х' } }));
      const u = await tx.user.create({ data: { organizationId: w.a.id, email: `u-${uid()}@t.local`, passwordHash: 'x', firstName: 'У', lastName: 'У' } });
      expect(u.tenantId).toBe(DEFAULT_TENANT);
      await tx.orgMembership.create({ data: { userId: u.id, organizationId: w.a2.id, role: 'accountant' } }); // другая организация того же клиента — можно
      await rejected(tx, () => tx.orgMembership.create({ data: { userId: u.id, organizationId: w.b.id, role: 'owner' } })); // чужой клиент — нет
      await rejected(tx, () => tx.orgMembership.create({ data: { userId: randomUUID(), organizationId: w.a.id, role: 'owner' } })); // несуществующий пользователь
    });
  });

  it('документ и строки не ссылаются на справочник и склады другого клиента — ни при создании, ни при изменении', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      // Свой общий справочник — любой организации клиента
      const ok = await tx.document.create({ data: { docType: 'SUPPLY', date: new Date(), organizationId: w.a2.id, counterpartyId: w.t1c.counterparty.id, storeId: w.a2store.id } });
      await tx.documentLine.create({ data: { documentId: ok.id, lineNo: 1, productId: w.t1c.product.id, qty: 2 } });
      // Чужой клиент
      await rejected(tx, () => tx.document.create({ data: { docType: 'SUPPLY', date: new Date(), organizationId: w.b.id, counterpartyId: w.t1c.counterparty.id } }));
      await rejected(tx, () => tx.document.create({ data: { docType: 'SUPPLY', date: new Date(), organizationId: w.a.id, storeId: w.t2c.store.id } }));
      await rejected(tx, () => tx.documentLine.create({ data: { documentId: ok.id, lineNo: 2, productId: w.t2c.product.id, qty: 1 } }));
      await rejected(tx, () => tx.document.update({ where: { id: ok.id }, data: { counterpartyId: w.t2c.counterparty.id } }));
      // Клиент, объявленный явно, не может «переназначить» организацию другого клиента
      await rejected(tx, () => tx.counterparty.create({ data: { tenantId: DEFAULT_TENANT, organizationId: w.b.id, name: 'подмена' } }));
    });
  });

  it('остатки, цены, штрихкоды, ячейки и договоры — в пределах одного клиента', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.stock.create({ data: { productId: w.t1c.product.id, storeId: w.t1c.store.id, qty: 1 } });
      await rejected(tx, () => tx.stock.create({ data: { productId: w.t1c.product.id, storeId: w.t2c.store.id, qty: 1 } }));
      await rejected(tx, () => tx.price.create({ data: { productId: w.t1c.product.id, priceTypeId: w.t2c.priceType.id, price: 10 } }));
      const bin = await tx.bin.create({ data: { storeId: w.t2c.store.id, name: 'B-1' } });
      await rejected(tx, () => tx.stock.create({ data: { productId: w.t2c.product.id, storeId: w.t2c.store.id, binId: bin.id, tenantId: DEFAULT_TENANT } }));
      await rejected(tx, () => tx.product.create({ data: { tenantId: w.t2.id, name: 'чужая единица', uomId: w.t1c.uom.id } }));
      await rejected(tx, () => tx.productBarcode.create({ data: { tenantId: w.t2.id, productId: w.t1c.product.id, barcode: `46${uid()}` } }));
      await rejected(tx, () => tx.contract.create({ data: { tenantId: w.t2.id, organizationId: w.b.id, counterpartyId: w.t1c.counterparty.id, number: '1' } }));
      // FP-026: договор — организации; организация другого клиента с контрагентом этого клиента не связывается.
      await rejected(tx, () => tx.contract.create({ data: { tenantId: DEFAULT_TENANT, organizationId: w.b.id, counterpartyId: w.t1c.counterparty.id, number: '2' } }));
    });
  });

  it('внутри клиента объекты одной организации не связываются с объектами другой', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.pOSTerminal.create({ data: { organizationId: w.a.id, storeId: w.t1c.store.id, name: 'Касса', code: `K-${uid()}` } });
      await rejected(tx, () => tx.pOSTerminal.create({ data: { organizationId: w.a.id, storeId: w.a2store.id, name: 'Касса', code: `K-${uid()}` } }));

      const dA = await tx.department.create({ data: { organizationId: w.a.id, name: 'Отдел A' } });
      await rejected(tx, () => tx.department.create({ data: { organizationId: w.a2.id, name: 'Отдел A2', parentId: dA.id } }));

      const person = (orgId: string) => tx.individual.create({ data: { organizationId: orgId, iin: '900101300123', lastName: 'Иванов', firstName: 'Иван', birthDate: new Date('1990-01-01'), gender: 'MALE' } });
      const pA = await person(w.a.id);
      await person(w.a2.id);
      const contract = await tx.hrContract.create({ data: { organizationId: w.a.id, individualId: pA.id, contractNumber: '1', contractDate: new Date('2026-01-01'), hireDate: new Date('2026-01-01') } });
      await rejected(tx, () => tx.hrContract.create({ data: { organizationId: w.a2.id, individualId: pA.id, contractNumber: '1', contractDate: new Date('2026-01-01'), hireDate: new Date('2026-01-01') } }));

      const grade = await tx.salaryGrade.create({ data: { organizationId: w.a.id, gradeLevel: '1', minSalary: 100, maxSalary: 200, validFrom: new Date('2026-01-01') } });
      const rateA = await tx.rateType.create({ data: { organizationId: w.a.id, code: 'BASE', name: 'Оклад' } });
      const rateA2 = await tx.rateType.create({ data: { organizationId: w.a2.id, code: 'BASE', name: 'Оклад' } });
      const grv = await tx.gradeRateValue.create({ data: { gradeId: grade.id, rateTypeId: rateA.id, value: 150, validFrom: new Date('2026-01-01') } });
      expect(grv.organizationId).toBe(w.a.id); // от разряда
      await rejected(tx, () => tx.gradeRateValue.create({ data: { gradeId: grade.id, rateTypeId: rateA2.id, value: 150, validFrom: new Date('2026-01-01') } }));
      await rejected(tx, () => tx.staffingSlot.create({ data: { organizationId: w.a2.id, departmentId: dA.id, positionId: 'p', nkzCode: '111111', gradeId: grade.id, validFrom: new Date('2026-01-01') } }));
      const hist = { validFrom: new Date('2026-01-01'), departmentId: dA.id, positionId: 'p', calculatedSalary: 150, eventType: 'HIRE' };
      expect((await tx.employmentHistory.create({ data: { contractId: contract.id, rateTypeId: rateA.id, ...hist } })).organizationId).toBe(w.a.id);
      await rejected(tx, () => tx.employmentHistory.create({ data: { contractId: contract.id, rateTypeId: rateA2.id, ...hist } }));

      const periodA2 = await tx.payrollPeriod.create({ data: { organizationId: w.a2.id, period: new Date('2026-01-01') } });
      const money = { baseAccrued: 1, totalGrossSalary: 1, opvAmount: 0, vosmsAmount: 0, ipnAmount: 0, soAmount: 0, snAmount: 0, oosmsAmount: 0, opvrAmount: 0, netSalaryToPay: 1 };
      await rejected(tx, () => tx.payrollResult.create({ data: { payrollPeriodId: periodA2.id, contractId: contract.id, period: new Date('2026-01-01'), ...money } }));
    });
  });

  it('проводка не попадает в запись движений другой организации', async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const account = await tx.accAccount.findFirstOrThrow({ where: { organizationId: null, isGroup: false } });
      const entry = (orgId: string) => tx.accEntry.create({ data: { organizationId: orgId, sourceType: 'TEST', sourceId: uid(), sourceVersion: 1, ruleCode: 'T', ruleVersion: '1', date: new Date() } });
      const eA = await entry(w.a.id);
      await rejected(tx, () => tx.accPosting.create({ data: { entryId: eA.id, organizationId: w.a2.id, date: new Date(), lineNo: 1, side: 'D', accountId: account.id, amount: 1 } }));
    });
  });

  it('новая организация создаётся у клиента её создателя', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { tenantId: DEFAULT_TENANT } });
    const org = await s.refs.createOrganization(user.id, { name: `Новая ${uid()}` });
    expect(org.tenantId).toBe(DEFAULT_TENANT);
  });
});
