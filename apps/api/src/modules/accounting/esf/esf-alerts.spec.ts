import { readFileSync } from 'fs';
import { join } from 'path';
import { EsfMetrics, RENOTIFY_MS, evaluateEsfAlerts, shouldNotify } from './esf-alerts';

const base: EsfMetrics = {
  organizationId: 'o1', environment: 'TEST', sessionOpen: true, syncOkAgeSec: 60, syncFailures: 0, lastSyncError: null,
  cursorLagSec: 3600, unknownCount: 0, unknownOldestAgeSec: null, sendingStuck: 0, quarantineCount: 0, quarantineConflicts: 0, readyCount: 0,
  readyOldestAgeSec: null, rejected24h: 0, signingFailures24h: 0, decisionsOverdue: 0,
};
const keys = (m: Partial<EsfMetrics>) => evaluateEsfAlerts({ ...base, ...m }).map((a) => `${a.key}:${a.severity}`);

describe('FP-022: правила оповещений ЭСФ', () => {
  it('здоровое состояние — тишина (в т.ч. большой лаг курсора у тихих поставщиков)', () => {
    expect(keys({ cursorLagSec: 30 * 86400 })).toEqual([]);
  });

  it('UNKNOWN: свежий — молчим (идёт сверка), 30 мин — предупреждение, сутки — критично', () => {
    expect(keys({ unknownCount: 1, unknownOldestAgeSec: 10 * 60 })).toEqual([]);
    expect(keys({ unknownCount: 2, unknownOldestAgeSec: 31 * 60 })).toEqual(['ESF_UNKNOWN:WARNING']);
    expect(keys({ unknownCount: 2, unknownOldestAgeSec: 25 * 3600 })).toEqual(['ESF_UNKNOWN:CRITICAL']);
  });

  it('зависшая отправка — критично, ответственный — дежурный инженер', () => {
    const [a] = evaluateEsfAlerts({ ...base, sendingStuck: 1 });
    expect(a).toMatchObject({ key: 'ESF_SENDING_STUCK', severity: 'CRITICAL', runbook: 'docs/erp/runbooks/ESF.md#esf-sending-stuck' });
    expect(a.owner).toMatch(/Дежурный инженер/);
  });

  it('синхронизация: сбои подряд вытесняют «устарела» (одна причина — одно оповещение)', () => {
    expect(keys({ syncOkAgeSec: 3 * 3600 })).toEqual(['ESF_SYNC_STALE:WARNING']);
    expect(keys({ syncOkAgeSec: 30 * 3600 })).toEqual(['ESF_SYNC_STALE:CRITICAL']);
    expect(keys({ syncOkAgeSec: 3 * 3600, syncFailures: 3, lastSyncError: 'ESF_NETWORK' })).toEqual(['ESF_SYNC_FAILING:WARNING']);
    expect(keys({ syncFailures: 10 })).toEqual(['ESF_SYNC_FAILING:CRITICAL']);
    // Сессию закрыла ИС ЭСФ — не «синхронизация падает», а «нет входа» (если есть работа).
    expect(keys({ sessionOpen: false, syncFailures: 10, unknownCount: 1, unknownOldestAgeSec: 60 })).toEqual(['ESF_NO_SESSION:WARNING']);
    expect(keys({ sessionOpen: false, syncOkAgeSec: null })).toEqual([]); // нет сессии и нет работы — не тревога
  });

  it('нет входа, а работа есть — бухгалтеру', () => {
    expect(keys({ sessionOpen: false, syncOkAgeSec: null, unknownCount: 1, unknownOldestAgeSec: 60 })).toEqual(['ESF_NO_SESSION:WARNING']);
    expect(keys({ sessionOpen: false, readyCount: 3, readyOldestAgeSec: 2 * 86400 })).toEqual(['ESF_NO_SESSION:WARNING']);
    expect(keys({ sessionOpen: false, readyCount: 3, readyOldestAgeSec: 3600 })).toEqual([]);
  });

  it('карантин, отказы подписи, отклонённые, просроченные решения', () => {
    expect(keys({ quarantineCount: 1 })).toEqual(['ESF_QUARANTINE:WARNING']);
    expect(keys({ quarantineCount: 2, quarantineConflicts: 1 })).toEqual(['ESF_QUARANTINE:CRITICAL']);
    expect(keys({ signingFailures24h: 2 })).toEqual([]);
    expect(keys({ signingFailures24h: 3 })).toEqual(['ESF_SIGNING_FAILURES:WARNING']);
    expect(keys({ rejected24h: 1 })).toEqual(['ESF_REJECTED:WARNING']);
    expect(keys({ decisionsOverdue: 2 })).toEqual(['ESF_DECISIONS_OVERDUE:WARNING']);
  });

  it('подавление повторов: новое — сразу; та же важность — после интервала; рост важности — сразу', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(shouldNotify(null, 'WARNING', now)).toBe(true);
    expect(shouldNotify({ severity: 'WARNING', notifiedAt: ago(RENOTIFY_MS.WARNING - 1000) }, 'WARNING', now)).toBe(false);
    expect(shouldNotify({ severity: 'WARNING', notifiedAt: ago(RENOTIFY_MS.WARNING) }, 'WARNING', now)).toBe(true);
    expect(shouldNotify({ severity: 'WARNING', notifiedAt: ago(60_000) }, 'CRITICAL', now)).toBe(true);
    expect(shouldNotify({ severity: 'CRITICAL', notifiedAt: ago(60_000) }, 'WARNING', now)).toBe(false);
  });

  it('у каждого оповещения есть раздел в runbook (и у правил Prometheus)', () => {
    const root = join(__dirname, '../../../../../..');
    const md = readFileSync(join(root, 'docs/erp/runbooks/ESF.md'), 'utf8');
    const anchors = new Set([...md.matchAll(/<a id="([\w-]+)"><\/a>/g)].map((m) => m[1]));
    const all = evaluateEsfAlerts({ ...base, sessionOpen: true, syncOkAgeSec: 9e9, syncFailures: 0, unknownCount: 1, unknownOldestAgeSec: 9e9, sendingStuck: 1, quarantineCount: 1, signingFailures24h: 9, rejected24h: 1, decisionsOverdue: 1 })
      .concat(evaluateEsfAlerts({ ...base, syncFailures: 99 }), evaluateEsfAlerts({ ...base, sessionOpen: false, unknownCount: 1, unknownOldestAgeSec: 60 }));
    expect(new Set(all.map((a) => a.key)).size).toBe(9);
    for (const a of all) expect(anchors).toContain(a.runbook.split('#')[1]);
    const rules = readFileSync(join(root, 'deploy/monitoring/flowpos-esf.rules.yml'), 'utf8');
    for (const m of rules.matchAll(/runbook: "docs\/erp\/runbooks\/ESF\.md#([\w-]+)"/g)) expect(anchors).toContain(m[1]);
  });
});
