// FP-021 приёмка «Stale worker не подтверждает чужой lease; jitter/Retry-After; unsafe stage не retry» —
// push-worker на рабочей роли (RLS) против реальной таблицы outbox; 1С подменена управляемым клиентом.
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { runtimeDatabaseUrl, startApp, call, login, makeUser, HttpApp } from './http-app';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { PrismaService as PushPrisma } from '../../push-worker/src/prisma.service';
import { ClaimedEntry, PushService } from '../../push-worker/src/modules/push/push.service';

const uid = () => randomUUID().slice(0, 8);
const owner = new PrismaService();
PushPrisma.nextUrl = runtimeDatabaseUrl();
const pw = new PushPrisma();

type Behaviour = (e: ClaimedEntry) => Promise<any>;
/** Воркер с подменённым клиентом 1С: каждая операция вызывает behaviour. */
class TestWorker extends PushService {
  constructor(id: string, public behaviour: Behaviour) { super(pw as any, id); }
  protected createClient(e: ClaimedEntry): any {
    const call = () => this.behaviour(e);
    return { createDocument: call, postDocument: call, unpostDocument: call, deleteRef: call, createRef: call, updateRef: call };
  }
}
const ok = (guid = randomUUID()) => async () => ({ guid, version: '1' });
const httpErr = (status: number, headers: Record<string, string> = {}, data: any = {}) => async () => {
  throw Object.assign(new Error(`HTTP ${status}`), { response: { status, headers, data } });
};
const netErr = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };

let org: string, conn: string, doc: string;

beforeAll(async () => {
  await defaultTenant(owner);
  org = (await owner.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `Lease ${uid()}` } })).id;
  conn = (await owner.onecConnection.create({ data: { organizationId: org, name: '1С', baseCode: `b-${uid()}`, baseUrl: 'http://1c.invalid', username: 'u', passwordEnc: 'p' } })).id;
  doc = (await owner.document.create({ data: { docType: 'SUPPLY', date: new Date(), organizationId: org } })).id;
}, 60_000);
afterAll(async () => {
  await owner.outbox.deleteMany({ where: { connectionId: conn } });
  await Promise.all([owner.$disconnect(), pw.$disconnect()]);
});

/** Очистить очередь этого подключения и поставить одну запись документа. */
async function enqueue(operation = 'CREATE') {
  await owner.outbox.deleteMany({ where: { connectionId: conn } });
  return owner.outbox.create({ data: { tenantId: DEFAULT_TENANT, connectionId: conn, idempotencyKey: `k-${uid()}`, entity: 'document', localId: doc, operation, payload: { onecGuid: randomUUID() } } });
}
const row = (id: string) => owner.outbox.findUniqueOrThrow({ where: { id } });
const expireLease = (id: string) => owner.outbox.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });

describe('FP-021: аренда и fencing', () => {
  it('два воркера не берут одну запись', async () => {
    const e = await enqueue();
    const [a, b] = await Promise.all([new TestWorker('w-a', ok()).claim(10), new TestWorker('w-b', ok()).claim(10)]);
    const mine = [...a, ...b].filter((x) => x.id === e.id);
    expect(mine).toHaveLength(1);
    const r = await row(e.id);
    expect([r.status, r.stage, r.attempts, r.fencingVersion]).toEqual(['SENDING', 'CLAIMED', 1, 1]);
  });

  it('устаревший воркер не подтверждает результат и не пишет GUID; новый владелец — подтверждает', async () => {
    const e = await enqueue();
    const guidStale = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Воркер A «зависает» посреди отправки: аренда истекает, запись (ещё на CLAIMED? нет — A уже отметил SENDING).
    const slow = new TestWorker('w-slow', async () => { await gate; return { guid: guidStale }; });
    const [entryA] = await slow.claim(10);
    const pA = slow.processEntry(entryA);
    await new Promise((r) => setTimeout(r, 200)); // A отметил stage=SENDING и ждёт 1С
    expect((await row(e.id)).stage).toBe('SENDING');
    // Аренда A истекла: после начала отправки — UNKNOWN, никто не переотправляет.
    await expireLease(e.id);
    const w2 = new TestWorker('w-2', ok());
    expect(await w2.recoverExpired()).toBe(1);
    expect((await w2.claim(10)).map((x) => x.id)).not.toContain(e.id);
    release();
    expect(await pA).toBe('STALE');
    const r = await row(e.id);
    expect(r.status).toBe('UNKNOWN');
    expect((await owner.document.findUniqueOrThrow({ where: { id: doc } })).onecGuid).not.toBe(guidStale);
  });

  it('аренда истекла до отправки (CLAIMED): запись берёт другой воркер, старый не отправляет и не подтверждает', async () => {
    const e = await enqueue();
    const sentBy: string[] = [];
    const a = new TestWorker('w-a', async () => { sentBy.push('a'); return { guid: randomUUID() }; });
    const b = new TestWorker('w-b', async () => { sentBy.push('b'); return { guid: randomUUID() }; });
    const [entryA] = await a.claim(10);
    await expireLease(e.id);
    const [entryB] = await b.claim(10);
    expect(entryB.id).toBe(e.id);
    expect(entryB.fencingVersion).toBe(entryA.fencingVersion + 1);
    expect(await a.processEntry(entryA)).toBe('STALE'); // fencing: до сети не дошёл
    expect(await b.processEntry(entryB)).toBe('DONE');
    expect(sentBy).toEqual(['b']);
    const r = await row(e.id);
    expect([r.status, r.leaseOwner, r.attempts]).toEqual(['DONE', null, 2]);
  });
});

describe('FP-021: повторы', () => {
  it('нет соединения — повтор с jitter-задержкой, аренда снята', async () => {
    const e = await enqueue();
    const w = new TestWorker('w', netErr('ECONNREFUSED'));
    const t0 = Date.now();
    const [entry] = await w.claim(10);
    expect(await w.processEntry(entry)).toBe('RETRY');
    const r = await row(e.id);
    expect([r.status, r.leaseOwner, r.stage]).toEqual(['PENDING', null, null]);
    // Полный jitter первой попытки: от 1 с до 60 с.
    expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0 + 1000);
    expect(r.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('429 с Retry-After — не раньше указанного', async () => {
    const e = await enqueue();
    const w = new TestWorker('w', httpErr(429, { 'retry-after': '600' }));
    const [entry] = await w.claim(10);
    const t0 = Date.now();
    expect(await w.processEntry(entry)).toBe('RETRY');
    expect((await row(e.id)).nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0 + 600_000 - 1000);
  });

  it('5xx и таймаут после отправки — UNKNOWN, без повтора; с подтверждённой идемпотентностью 1С — повтор', async () => {
    for (const fail of [httpErr(500), netErr('ECONNRESET'), netErr('ECONNABORTED')]) {
      const e = await enqueue();
      const w = new TestWorker('w', fail);
      const [entry] = await w.claim(10);
      expect(await w.processEntry(entry)).toBe('UNKNOWN');
      expect((await row(e.id)).status).toBe('UNKNOWN');
      await owner.outbox.update({ where: { id: e.id }, data: { nextAttemptAt: new Date(0) } });
      expect(await w.claim(10)).toHaveLength(0);
    }
    process.env.ONEC_IDEMPOTENCY_CONFIRMED = '1';
    try {
      const e = await enqueue('CREATE');
      const w = new TestWorker('w', httpErr(500));
      expect(await w.processEntry((await w.claim(10))[0])).toBe('RETRY');
      // POST (проведение) не идемпотентен по ключу — всё равно UNKNOWN.
      const p = await enqueue('POST');
      expect(await w.processEntry((await w.claim(10)).find((x) => x.id === p.id)!)).toBe('UNKNOWN');
      void e;
    } finally {
      delete process.env.ONEC_IDEMPOTENCY_CONFIRMED;
    }
  });

  it('4xx — в DLQ сразу; 409 с GUID — успех', async () => {
    const e = await enqueue();
    const w = new TestWorker('w', httpErr(422, {}, { message: 'нет склада' }));
    expect(await w.processEntry((await w.claim(10))[0])).toBe('DEAD');
    expect((await row(e.id)).status).toBe('DEAD');
    const guid = randomUUID();
    const c = await enqueue();
    const w409 = new TestWorker('w', httpErr(409, {}, { guid }));
    expect(await w409.processEntry((await w409.claim(10))[0])).toBe('DONE');
    expect((await row(c.id)).status).toBe('DONE');
    expect((await owner.document.findUniqueOrThrow({ where: { id: doc } })).onecGuid).toBe(guid);
  });
});

describe('FP-021: оператор возвращает запись из UNKNOWN', () => {
  let h: HttpApp;
  beforeAll(async () => { h = await startApp(); }, 60_000);
  afterAll(async () => h?.app.close());

  it('с причиной и правом sync.manage; не из DONE; запись в журнале', async () => {
    const e = await enqueue();
    await owner.outbox.update({ where: { id: e.id }, data: { status: 'UNKNOWN', lastError: '500' } });
    const admin = await makeUser(h, DEFAULT_TENANT, org, { role: 'admin' });
    const cashier = await makeUser(h, DEFAULT_TENANT, org, { role: 'cashier' });
    const tAdmin = (await login(h, admin.email)).token;
    expect((await call(h, 'POST', `/sync/outbox/${e.id}/requeue`, { token: (await login(h, cashier.email)).token, body: { reason: 'проверено' } })).status).toBe(403);
    expect((await call(h, 'POST', `/sync/outbox/${e.id}/requeue`, { token: tAdmin, body: { reason: 'да' } })).body.code).toBe('REASON_REQUIRED');
    const okRes = await call(h, 'POST', `/sync/outbox/${e.id}/requeue`, { token: tAdmin, body: { reason: 'В 1С документа нет — проверено вручную' } });
    expect([okRes.status, okRes.body.previousStatus]).toEqual([201, 'UNKNOWN']);
    const r = await row(e.id);
    expect([r.status, r.attempts]).toEqual(['PENDING', 0]);
    expect(await owner.auditLog.count({ where: { entity: 'outbox', entityId: e.id, action: 'OUTBOX_REQUEUE' } })).toBe(1);
    expect((await call(h, 'POST', `/sync/outbox/${e.id}/requeue`, { token: tAdmin, body: { reason: 'повторно ещё раз' } })).body.code).toBe('OUTBOX_NOT_REQUEUEABLE');
  });
});
