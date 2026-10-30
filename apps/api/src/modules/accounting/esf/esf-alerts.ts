// FP-022: метрики обмена с ИС ЭСФ и правила оповещений (чистые функции — проверяются без БД).
// Каждое правило: порог, важность, ответственный (кто действует) и раздел runbook (что делать).
// Пороги — эксплуатационные, не юридические сроки: юридические сроки решений задаёт методолог (FP-018).

export interface EsfMetrics {
  organizationId: string;
  environment: string;
  /** Открыта ли сессия ИС ЭСФ (без неё фоновая сверка и получение не работают). */
  sessionOpen: boolean;
  /** Секунд с последней успешной синхронизации; null — ни одной не было. */
  syncOkAgeSec: number | null;
  /** Неудачных синхронизаций подряд и текст последней ошибки (без секретов). */
  syncFailures: number;
  lastSyncError: string | null;
  /** Секунд от курсора получения входящих до сейчас (информативно: у тихих поставщиков растёт естественно). */
  cursorLagSec: number | null;
  /** Результат отправки неизвестен — повтор заблокирован до сверки (FP-017). */
  unknownCount: number;
  unknownOldestAgeSec: number | null;
  /** Отправка дольше аренды (процесс упал/завис, восстановление не сработало). */
  sendingStuck: number;
  /** Входящие, которые не удалось разобрать (временный карантин до FP-024). */
  quarantineCount: number;
  /** Подписанные готовые, но не отправленные; самый старый. */
  readyCount: number;
  readyOldestAgeSec: number | null;
  rejected24h: number;
  signingFailures24h: number;
  /** Решения FP-018 с истёкшим сроком (срок задан правилом). */
  decisionsOverdue: number;
}

export type Severity = 'WARNING' | 'CRITICAL';

export interface AlertFiring {
  key: string;
  severity: Severity;
  owner: string;
  runbook: string;
  message: string;
  value: Record<string, unknown>;
}

const RUNBOOK = 'docs/erp/runbooks/ESF.md';
const OWNER_ACCOUNTANT = 'Ответственный за ЭСФ в организации (бухгалтер с правом acc.esf.send)';
const OWNER_DECISIONS = 'Ответственный за решения ЭСФ (право acc.esf.approve)';
const OWNER_SRE = 'Дежурный инженер FlowPOS (эксплуатация/интеграция)';

const H = 3600;
const fmtAge = (s: number) => (s >= 2 * 86400 ? `${Math.floor(s / 86400)} дн.` : s >= 2 * H ? `${Math.floor(s / H)} ч` : `${Math.max(1, Math.floor(s / 60))} мин`);

/** Пороги; переопределяются в тестах. */
export const ESF_THRESHOLDS = {
  unknownWarnSec: 30 * 60,
  unknownCritSec: 24 * H,
  syncStaleWarnSec: 2 * H,
  syncStaleCritSec: 24 * H,
  syncFailuresWarn: 3,
  syncFailuresCrit: 10,
  readyWaitingSec: 24 * H,
  signingFailuresWarn: 3,
};

/** Интервал повторного уведомления по открытому оповещению той же важности. */
export const RENOTIFY_MS: Record<Severity, number> = { WARNING: 6 * H * 1000, CRITICAL: 1 * H * 1000 };

export function evaluateEsfAlerts(m: EsfMetrics, t = ESF_THRESHOLDS): AlertFiring[] {
  const out: AlertFiring[] = [];
  const add = (key: string, severity: Severity, owner: string, message: string, value: Record<string, unknown>) =>
    out.push({ key, severity, owner, runbook: `${RUNBOOK}#${key.toLowerCase().replace(/_/g, '-')}`, message, value });

  if (m.sendingStuck > 0) {
    add('ESF_SENDING_STUCK', 'CRITICAL', OWNER_SRE, `${m.sendingStuck} ЭСФ «отправляются» дольше допустимого — фоновое восстановление не сработало`, { sendingStuck: m.sendingStuck });
  }
  if (m.unknownCount > 0 && m.unknownOldestAgeSec != null && m.unknownOldestAgeSec >= t.unknownWarnSec) {
    const crit = m.unknownOldestAgeSec >= t.unknownCritSec;
    add('ESF_UNKNOWN', crit ? 'CRITICAL' : 'WARNING', OWNER_ACCOUNTANT,
      `${m.unknownCount} ЭСФ с неизвестным результатом отправки (старейший — ${fmtAge(m.unknownOldestAgeSec)}); повтор заблокирован до сверки`,
      { unknownCount: m.unknownCount, unknownOldestAgeSec: m.unknownOldestAgeSec });
  }
  // Без сессии синхронизация не идёт — сбои прошлой сессии уже не актуальны (тогда ESF_NO_SESSION).
  if (m.sessionOpen && m.syncFailures >= t.syncFailuresWarn) {
    add('ESF_SYNC_FAILING', m.syncFailures >= t.syncFailuresCrit ? 'CRITICAL' : 'WARNING', OWNER_SRE,
      `Синхронизация с ИС ЭСФ не удаётся ${m.syncFailures} раз подряд: ${m.lastSyncError ?? 'причина не записана'}`,
      { syncFailures: m.syncFailures, lastSyncError: m.lastSyncError });
  }
  // Устаревание — только при открытой сессии (без сессии синхронизация и не должна идти — это ESF_NO_SESSION).
  if (m.sessionOpen && (m.syncOkAgeSec == null || m.syncOkAgeSec >= t.syncStaleWarnSec) && m.syncFailures < t.syncFailuresWarn) {
    const age = m.syncOkAgeSec;
    add('ESF_SYNC_STALE', age != null && age >= t.syncStaleCritSec ? 'CRITICAL' : 'WARNING', OWNER_SRE,
      age == null ? 'Сессия ИС ЭСФ открыта, но успешной синхронизации ещё не было' : `Последняя успешная синхронизация с ИС ЭСФ — ${fmtAge(age)} назад`,
      { syncOkAgeSec: age });
  }
  if (!m.sessionOpen && (m.unknownCount > 0 || (m.readyCount > 0 && (m.readyOldestAgeSec ?? 0) >= t.readyWaitingSec))) {
    add('ESF_NO_SESSION', 'WARNING', OWNER_ACCOUNTANT,
      `Нет входа в ИС ЭСФ, а есть работа: ${[m.unknownCount ? `${m.unknownCount} на сверке` : '', m.readyCount ? `${m.readyCount} готовы к отправке` : ''].filter(Boolean).join(', ')} — статусы и входящие не обновляются`,
      { unknownCount: m.unknownCount, readyCount: m.readyCount });
  }
  if (m.quarantineCount > 0) {
    add('ESF_QUARANTINE', 'WARNING', OWNER_ACCOUNTANT, `${m.quarantineCount} входящих ЭСФ не удалось разобрать — они не попали в реестр`, { quarantineCount: m.quarantineCount });
  }
  if (m.signingFailures24h >= t.signingFailuresWarn) {
    add('ESF_SIGNING_FAILURES', 'WARNING', OWNER_ACCOUNTANT, `${m.signingFailures24h} отказов проверки подписи за сутки — возможно, выбран не тот ключ или сертификат`, { signingFailures24h: m.signingFailures24h });
  }
  if (m.rejected24h > 0) {
    add('ESF_REJECTED', 'WARNING', OWNER_ACCOUNTANT, `ИС ЭСФ отклонила ${m.rejected24h} ЭСФ за сутки — см. вкладку «Ошибки»`, { rejected24h: m.rejected24h });
  }
  if (m.decisionsOverdue > 0) {
    add('ESF_DECISIONS_OVERDUE', 'WARNING', OWNER_DECISIONS, `${m.decisionsOverdue} решений по ЭСФ просрочены`, { decisionsOverdue: m.decisionsOverdue });
  }
  return out;
}

/** Что делать с открытым оповещением при очередной оценке: уведомлять или подавить повтор. */
export function shouldNotify(prev: { severity: string; notifiedAt: Date | null } | null, next: Severity, now: Date): boolean {
  if (!prev || !prev.notifiedAt) return true;
  if (prev.severity === 'WARNING' && next === 'CRITICAL') return true; // рост важности — сразу
  return now.getTime() - prev.notifiedAt.getTime() >= RENOTIFY_MS[next];
}
