// FP-009 приёмка «Runtime role без BYPASSRLS; rollback; composite FK; outbox после commit» — на рабочей роли
// flowpos_app (политики RLS действуют), данные готовит владелец (BYPASSRLS). Два клиента: T1 и T2.
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { runAsSystem, runAsTenant } from '../src/common/db-context';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { SalesService } from '../src/modules/trade/sales.service';
import { runtimeDatabaseUrl } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { PrismaService as SyncWorkerPrisma, runAsTenant as workerAsTenant } from '../../sync-worker/src/prisma.service';
import { PullService as OnecPullService } from '../../sync-worker/src/modules/pull/pull.service';
import { PrismaService as PushWorkerPrisma } from '../../push-worker/src/prisma.service';
import { PushService } from '../../push-worker/src/modules/push/push.service';

const uid = () => randomUUID().slice(0, 8);
const owner = new PrismaService();

/**
 * Клиент рабочей роли. Адрес передаётся явно: Prisma читает DATABASE_URL не при создании, а при первом
 * подключении — подмена переменной на время создания дала бы клиента владельца.
 */
function asRuntime<T>(make: () => T): T {
  PrismaService.nextUrl = runtimeDatabaseUrl();
  SyncWorkerPrisma.nextUrl = runtimeDatabaseUrl();
  PushWorkerPrisma.nextUrl = runtimeDatabaseUrl();
  return make();
}
const app = asRuntime(() => new PrismaService());

let t2: string;
const T1 = DEFAULT_TENANT;
const w: Record<string, any> = {};

beforeAll(async () => {
  await defaultTenant(owner);
  t2 = (await owner.tenant.create({ data: { name: `RLS ${uid()}` } })).id;
  for (const [k, tenantId] of [['1', T1], ['2', t2]] as const) {
    const org = await owner.organization.create({ data: { tenantId, name: `RLS ${k} ${uid()}` } });
    const uom = await owner.uom.create({ data: { tenantId, name: 'шт', shortName: 'шт' } });
    const product = await owner.product.create({ data: { tenantId, name: `Товар ${k}`, uomId: uom.id } });
    const store = await owner.store.create({ data: { organizationId: org.id, name: `Склад ${k}` } });
    const doc = await owner.document.create({ data: { docType: 'SUPPLY', date: new Date(), organizationId: org.id, storeId: store.id } });
    const entry = await owner.accEntry.create({ data: { organizationId: org.id, sourceType: 'RLS', sourceId: uid(), sourceVersion: 1, ruleCode: 'r', ruleVersion: '1', date: new Date() } });
    const terminal = await owner.pOSTerminal.create({ data: { organizationId: org.id, storeId: store.id, name: 'Касса', code: `RLS-${uid()}` } });
    const shift = await owner.pOSShift.create({ data: { terminalId: terminal.id, number: '1', openedAt: new Date() } });
    const outbox = await owner.outbox.create({ data: { tenantId, idempotencyKey: `rls-${uid()}`, entity: 'document', localId: doc.id, operation: 'CREATE', payload: {} } });
    w[k] = { org, uom, product, store, doc, entry, shift, outbox };
  }
}, 60_000);

afterAll(async () => {
  const orgs = [w['2']?.org?.id].filter(Boolean);
  await owner.outbox.deleteMany({ where: { tenantId: t2 } });
  await owner.pOSShift.deleteMany({ where: { terminal: { tenantId: t2 } } });
  await owner.pOSTerminal.deleteMany({ where: { tenantId: t2 } });
  await owner.accEntry.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.idMap.deleteMany({ where: { connection: { organizationId: { in: orgs } } } });
  await owner.onecConnection.deleteMany({ where: { organizationId: { in: orgs } } });
  await owner.document.deleteMany({ where: { tenantId: t2 } });
  await owner.product.deleteMany({ where: { tenantId: t2 } });
  await owner.uom.deleteMany({ where: { tenantId: t2 } });
  await owner.store.deleteMany({ where: { tenantId: t2 } });
  await owner.organization.deleteMany({ where: { tenantId: t2 } });
  await owner.tenant.delete({ where: { id: t2 } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

const pgCode = async (p: PromiseLike<unknown>) => {
  try { await p; return 'OK'; } catch (e: any) { return /42501|row-level security/.test(e.message) ? 'RLS' : /Foreign key|foreign key/.test(e.message) ? 'FK' : e.code ?? e.message.slice(0, 80); }
};

describe('FP-009: рабочая роль', () => {
  it('без SUPERUSER и BYPASSRLS, не владелец таблиц, DDL и отключение RLS запрещены', async () => {
    const [role] = await owner.$queryRaw<any[]>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'flowpos_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [own] = await owner.$queryRaw<any[]>`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'flowpos_app'`;
    expect(own.n).toBe(0);
    await expect(runAsSystem(() => app.$executeRawUnsafe('CREATE TABLE fp009_probe (id int)'))).rejects.toThrow(/permission denied/);
    await expect(runAsSystem(() => app.$executeRawUnsafe('ALTER TABLE products DISABLE ROW LEVEL SECURITY'))).rejects.toThrow(/must be owner/);
    await expect(runAsSystem(() => app.$executeRawUnsafe('DROP POLICY fp_tenant ON products'))).rejects.toThrow(/must be owner/);
  });

  it('RLS (FORCE) включён на всех таблицах, кроме глобальных справочников', async () => {
    const rows = await owner.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity) ORDER BY 1`;
    expect(rows.map((r) => r.relname)).toEqual(['acc_charts', 'currencies', 'currency_rates', 'permissions', 'role_permissions', 'roles', 'vat_rates']);
  });
});

describe('FP-009: изоляция клиентов на рабочей роли', () => {
  it('без контекста — ни одной строки; системный режим — все', async () => {
    expect(await app.product.count({ where: { id: { in: [w['1'].product.id, w['2'].product.id] } } })).toBe(0);
    expect(await app.organization.count({ where: { id: { in: [w['1'].org.id, w['2'].org.id] } } })).toBe(0);
    expect(await runAsSystem(() => app.product.count({ where: { id: { in: [w['1'].product.id, w['2'].product.id] } } }))).toBe(2);
  });

  it.each([
    ['товары (tenant_id)', 'product'],
    ['документы (tenant_id)', 'doc'],
    ['записи движений (через организацию)', 'entry'],
    ['смены кассы (через родителя)', 'shift'],
    ['outbox (tenant_id)', 'outbox'],
  ])('%s: клиент видит своё и не видит чужое', async (_n, key) => {
    const model: Record<string, string> = { product: 'product', doc: 'document', entry: 'accEntry', shift: 'pOSShift', outbox: 'outbox' };
    const m = (app as any)[model[key]];
    await runAsTenant(T1, async () => {
      expect(await m.findUnique({ where: { id: w['1'][key].id } })).not.toBeNull();
      expect(await m.findUnique({ where: { id: w['2'][key].id } })).toBeNull();
    });
    await runAsTenant(t2, async () => {
      expect(await m.findUnique({ where: { id: w['1'][key].id } })).toBeNull();
    });
  });

  it('чужое не изменить и не удалить (0 строк), вставка в чужого клиента — отказ RLS', async () => {
    await runAsTenant(T1, async () => {
      expect((await app.product.updateMany({ where: { id: w['2'].product.id }, data: { name: 'захват' } })).count).toBe(0);
      expect((await app.document.deleteMany({ where: { id: w['2'].doc.id } })).count).toBe(0);
      expect(await pgCode(app.uom.create({ data: { tenantId: t2, name: 'x', shortName: 'x' } }))).toBe('RLS');
      expect(await pgCode(app.accEntry.create({ data: { organizationId: w['2'].org.id, sourceType: 'RLS', sourceId: uid(), sourceVersion: 1, ruleCode: 'r', ruleVersion: '1', date: new Date() } }))).toBe('RLS');
    });
    expect((await owner.product.findUniqueOrThrow({ where: { id: w['2'].product.id } })).name).toBe('Товар 2');
  });

  it('составной FK держит границу даже в системном режиме (когда RLS пропускает всё)', async () => {
    expect(await pgCode(runAsSystem(() => app.documentLine.create({ data: { documentId: w['1'].doc.id, lineNo: 99, productId: w['2'].product.id, qty: 1 } })))).toBe('FK');
  });
});

describe('FP-009: единица работы и outbox', () => {
  it('сбой в середине команды откатывает всё: документ, строки и outbox', async () => {
    const sales = new SalesService(app, new OutboxService(app));
    const s = { tenantId: T1, organizationId: w['1'].org.id, userId: 'u', role: 'owner' };
    const before = await owner.document.count({ where: { organizationId: w['1'].org.id, docType: 'CUSTOMER_ORDER' } });
    // Отказ при записи в outbox (после записи документа и строк в той же транзакции).
    await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fp009_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.payload::text LIKE '%rollback-probe%' THEN RAISE EXCEPTION 'сбой outbox (проверка отката)'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe('CREATE TRIGGER fp009_fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fp009_fail_outbox()');
    try {
      const r = runAsTenant(T1, () => sales.createOrder(s, { date: '2026-10-30', storeId: w['1'].store.id, items: [{ productId: w['1'].product.id, qty: 1, price: 5, note: 'rollback-probe' }] }));
      await expect(r).rejects.toThrow(/сбой outbox/);
    } finally {
      await owner.$executeRawUnsafe('DROP TRIGGER fp009_fail_outbox ON outbox');
      await owner.$executeRawUnsafe('DROP FUNCTION fp009_fail_outbox()');
    }
    expect(await owner.document.count({ where: { organizationId: w['1'].org.id, docType: 'CUSTOMER_ORDER' } })).toBe(before);
    expect(await owner.outbox.count({ where: { payload: { path: ['items', '0', 'note'], equals: 'rollback-probe' } } })).toBe(0);
  });

  it('outbox виден только после commit и получает клиента из транзакции', async () => {
    const other = asRuntime(() => new PrismaService());
    const key = `after-commit-${uid()}`;
    let seenInside = -1;
    try {
      await runAsTenant(T1, () => app.$transaction(async (tx) => {
        const doc = await tx.document.create({ data: { docType: 'SUPPLY', date: new Date(), organizationId: w['1'].org.id } });
        await tx.outbox.create({ data: { idempotencyKey: key, entity: 'document', localId: doc.id, operation: 'CREATE', payload: {} } });
        // Другое соединение (даже в системном режиме) незакоммиченную запись не видит.
        seenInside = await runAsSystem(() => other.outbox.count({ where: { idempotencyKey: key } }));
      }));
      expect(seenInside).toBe(0);
      const row = await runAsSystem(() => other.outbox.findUniqueOrThrow({ where: { idempotencyKey: key } }));
      expect(row.tenantId).toBe(T1); // из SET LOCAL транзакции, код его не передавал
      expect(await runAsTenant(t2, () => other.outbox.count({ where: { idempotencyKey: key } }))).toBe(0);
    } finally {
      await other.$disconnect();
    }
  });
});

describe('FP-009: воркеры на рабочей роли', () => {
  it('1С: без контекста подключений не видно; синхронизация пишет в клиента подключения', async () => {
    const wp = asRuntime(() => new SyncWorkerPrisma());
    try {
      const conn = await owner.onecConnection.create({ data: { organizationId: w['2'].org.id, name: 'B', baseCode: `b-${uid()}`, baseUrl: 'http://1c.invalid', username: 'u', passwordEnc: 'p' } });
      expect(await wp.onecConnection.count({ where: { id: conn.id } })).toBe(0);
      const pull = new OnecPullService(wp as any);
      const guid = randomUUID();
      await workerAsTenant(t2, () => wp.$transaction((tx) => (pull as any).upsertMirror(tx, { tenantId: t2, organizationId: w['2'].org.id }, 'uom', 'default', conn.id, { guid, version: '1', deletionMark: false, data: { name: 'кг' } })));
      expect((await owner.uom.findFirstOrThrow({ where: { onecGuid: guid } })).tenantId).toBe(t2);
      // Подмена клиента в области записи не проходит: строка не того клиента, что в контексте, — отказ RLS.
      await expect(workerAsTenant(T1, () => wp.$transaction((tx) => (pull as any).upsertMirror(tx, { tenantId: t2, organizationId: w['2'].org.id }, 'uom', 'default', conn.id, { guid: randomUUID(), version: '1', deletionMark: false, data: { name: 'л' } })))).rejects.toThrow(/row-level security|42501/);
    } finally {
      await wp.$disconnect();
    }
  });

  it('отправка в 1С: запись outbox клиента A не уходит в подключение клиента B', async () => {
    const pw = asRuntime(() => new PushWorkerPrisma());
    try {
      const connB = await owner.onecConnection.create({ data: { organizationId: w['2'].org.id, name: 'B', baseCode: `b-${uid()}`, baseUrl: 'http://127.0.0.1:9', username: 'u', passwordEnc: 'p' } });
      const leak = await owner.outbox.create({ data: { tenantId: T1, connectionId: connB.id, idempotencyKey: `leak-${uid()}`, entity: 'document', localId: w['1'].doc.id, operation: 'CREATE', payload: {} } });
      const own = await owner.outbox.create({ data: { tenantId: t2, connectionId: connB.id, idempotencyKey: `own-${uid()}`, entity: 'document', localId: w['2'].doc.id, operation: 'CREATE', payload: {} } });
      await (new PushService(pw as any) as any).processBatch();
      const [l, o] = await Promise.all([owner.outbox.findUniqueOrThrow({ where: { id: leak.id } }), owner.outbox.findUniqueOrThrow({ where: { id: own.id } })]);
      expect([l.status, l.attempts]).toEqual(['PENDING', 0]); // не выбрана вовсе
      expect(o.attempts).toBe(1); // выбрана и отправлялась (1С недоступна — ошибка, повтор позже)
      await owner.outbox.deleteMany({ where: { id: { in: [leak.id, own.id] } } });
    } finally {
      await pw.$disconnect();
    }
  });
});
