import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { currentDbContext, runAsSystem } from '../../../common/db-context';
import { redact, redactValue } from '../../../common/redact';
import { EsfMetrics, evaluateEsfAlerts, shouldNotify } from './esf-alerts';

/** Время отправки дольше этого — «зависла» (как EsfService.SEND_LEASE_MS). */
const SEND_LEASE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/**
 * FP-022: метрики обмена с ИС ЭСФ по организации, оповещения (с подавлением повторов) и выгрузка для
 * Prometheus. Логи и метрики показывают техническое состояние обмена — юридического принятия документа они
 * не подтверждают (это статус ИС ЭСФ в реестре).
 */
@Injectable()
export class EsfMonitorService {
  private log = new Logger('ESF-ALERT');
  /** Последний завершённый проход фоновой обработки ЭСФ в этом процессе (для метрики «обработка не идёт»). */
  static lastTickAt: Date | null = null;
  /** Подменяется в тестах: доставка уведомления во внешний канал. */
  notifier?: (payload: Record<string, unknown>) => Promise<void>;

  constructor(private prisma: PrismaService) {}

  async metrics(organizationId: string, now = new Date()): Promise<EsfMetrics> {
    const s = await this.prisma.esfSettings.findUnique({ where: { organizationId } });
    const env = s?.environment ?? 'TEST';
    const base = { organizationId, environment: env };
    const day = new Date(now.getTime() - DAY_MS);
    const age = (d: Date | null | undefined) => (d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000)) : null);
    const [session, unknown, sendingStuck, ready, rejected24h, signing, decisionsOverdue, quarantine, conflicts] = await Promise.all([
      this.prisma.esfSession.findFirst({ where: { organizationId, environment: env, closedAt: null }, select: { id: true } }),
      this.prisma.esfInvoice.aggregate({ where: { organizationId, environment: env, direction: 'OUTBOUND', status: 'UNKNOWN' }, _count: true, _min: { sentAt: true, updatedAt: true } }),
      this.prisma.esfInvoice.count({ where: { organizationId, environment: env, direction: 'OUTBOUND', status: 'SENDING', sentAt: { lt: new Date(now.getTime() - SEND_LEASE_MS) } } }),
      this.prisma.esfInvoice.aggregate({ where: { organizationId, environment: env, direction: 'OUTBOUND', status: 'READY' }, _count: true, _min: { createdAt: true } }),
      this.prisma.esfInvoice.count({ where: { organizationId, environment: env, direction: 'OUTBOUND', status: 'REJECTED', updatedAt: { gte: day } } }),
      this.prisma.auditLog.count({ where: { organizationId, action: 'ESF_SIGNING_REJECTED', ts: { gte: day } } }),
      this.prisma.esfDecision.count({ where: { organizationId, status: { in: ['PROPOSED', 'APPROVED'] }, dueAt: { lt: now } } }),
      // FP-024: открытые записи карантина входящих; конфликты (тот же ЭСФ — другое содержимое/тот же номер) — отдельно.
      this.prisma.esfInboundQuarantine.count({ where: { organizationId, environment: env, status: 'OPEN' } }),
      this.prisma.esfInboundQuarantine.count({ where: { organizationId, environment: env, status: 'OPEN', errorCode: { in: ['ESF_IN_HASH_CONFLICT', 'ESF_IN_KEY_CONFLICT'] } } }),
    ]);
    return {
      ...base,
      sessionOpen: !!session,
      syncOkAgeSec: age(s?.syncOkAt),
      syncFailures: s?.syncFailures ?? 0,
      lastSyncError: s?.syncError ?? null,
      cursorLagSec: age(s?.inboundLastEventAt),
      unknownCount: unknown._count,
      unknownOldestAgeSec: unknown._count ? age(unknown._min.sentAt ?? unknown._min.updatedAt) : null,
      sendingStuck,
      quarantineCount: quarantine,
      quarantineConflicts: conflicts,
      readyCount: ready._count,
      readyOldestAgeSec: ready._count ? age(ready._min.createdAt) : null,
      rejected24h,
      signingFailures24h: signing,
      decisionsOverdue,
    };
  }

  /**
   * Оценить правила и привести оповещения организации в соответствие: новое — открыть и уведомить; открытое —
   * обновить, уведомить повторно только при росте важности или после интервала подавления; не срабатывающее —
   * закрыть. Вызывается от имени клиента организации (RLS).
   */
  async evaluate(organizationId: string, now = new Date()) {
    const m = await this.metrics(organizationId, now);
    const firing = evaluateEsfAlerts(m);
    const open = await this.prisma.opsAlert.findMany({ where: { organizationId, resolvedAt: null } });
    const byKey = new Map(open.map((a) => [a.key, a]));
    const traceId = currentDbContext().traceId ?? null;
    const notified: string[] = [];
    for (const f of firing) {
      const prev = byKey.get(f.key) ?? null;
      const notify = shouldNotify(prev, f.severity, now);
      const data = { severity: f.severity, owner: f.owner, runbook: f.runbook, message: redact(f.message), value: redactValue(f.value) as any, lastSeenAt: now, traceId };
      let row;
      if (prev) {
        row = await this.prisma.opsAlert.update({ where: { id: prev.id }, data: { ...data, ...(notify ? { notifiedAt: now, notifyCount: { increment: 1 } } : {}) } });
      } else {
        try {
          row = await this.prisma.opsAlert.create({ data: { organizationId, key: f.key, openKey: f.key, openedAt: now, ...data, notifiedAt: now, notifyCount: 1 } });
        } catch (e: any) {
          if (e?.code === 'P2002') continue; // параллельная оценка уже открыла — уведомит она
          throw e;
        }
        await this.prisma.auditLog.create({ data: { organizationId, action: 'OPS_ALERT_RAISED', entity: 'ops_alert', entityId: row.id, after: { key: f.key, severity: f.severity, owner: f.owner } as any } });
      }
      if (notify) {
        notified.push(f.key);
        await this.deliver({ event: prev ? (prev.severity !== f.severity ? 'ESCALATED' : 'REMINDER') : 'RAISED', organizationId, ...f, message: data.message, value: data.value, openedAt: row.openedAt, traceId });
      }
    }
    const firingKeys = new Set(firing.map((f) => f.key));
    for (const a of open) {
      if (firingKeys.has(a.key)) continue;
      const c = await this.prisma.opsAlert.updateMany({ where: { id: a.id, resolvedAt: null }, data: { resolvedAt: now, openKey: null, traceId } });
      if (!c.count) continue;
      await this.prisma.auditLog.create({ data: { organizationId, action: 'OPS_ALERT_RESOLVED', entity: 'ops_alert', entityId: a.id, after: { key: a.key } as any } });
      await this.deliver({ event: 'RESOLVED', organizationId, key: a.key, severity: a.severity, owner: a.owner, runbook: a.runbook, message: a.message, openedAt: a.openedAt, traceId });
    }
    return { metrics: m, firing, notified };
  }

  /** Уведомление: строка лога (всегда) и вебхук OPS_ALERT_WEBHOOK_URL (если задан). Всё — без секретов. */
  private async deliver(payload: Record<string, unknown>) {
    const p = redactValue(payload);
    const line = `[${p.event}] ${p.key} ${p.severity ?? ''} org=${p.organizationId} — ${p.message} | ответственный: ${p.owner} | runbook: ${p.runbook}`;
    if (p.event === 'RESOLVED') this.log.log(line);
    else this.log.warn(line);
    try {
      if (this.notifier) return await this.notifier(p);
      const url = process.env.OPS_ALERT_WEBHOOK_URL;
      if (!url) return;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'flowpos', ...p }), signal: ctrl.signal });
        if (!res.ok) this.log.error(`Вебхук оповещений ответил ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      // Канал недоступен — оповещение остаётся открытым в БД и в интерфейсе; повтор — по интервалу.
      this.log.error(`Вебхук оповещений недоступен: ${redact(e)}`);
    }
  }

  /** Для экрана ЭСФ: метрики организации и открытые оповещения. */
  async health(organizationId: string) {
    const [metrics, alerts] = await Promise.all([
      this.metrics(organizationId),
      this.prisma.opsAlert.findMany({ where: { organizationId, resolvedAt: null }, orderBy: [{ severity: 'asc' }, { openedAt: 'asc' }] }),
    ]);
    return { metrics, alerts, workerLastTickAt: EsfMonitorService.lastTickAt };
  }

  /** Текст для Prometheus (все организации, системный режим). Метки — только идентификаторы, без имён и БИН. */
  async prometheus(now = new Date()) {
    return runAsSystem(async () => {
      const settings = await this.prisma.esfSettings.findMany({ select: { organizationId: true } });
      const lines: string[] = [];
      const gauge = (name: string, help: string, rows: [Record<string, string>, number | null][]) => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
        for (const [labels, v] of rows) {
          if (v == null) continue;
          const l = Object.entries(labels).map(([k, x]) => `${k}="${String(x).replace(/["\\\n]/g, '_')}"`).join(',');
          lines.push(`${name}{${l}} ${v}`);
        }
      };
      const all = await Promise.all(settings.map((s) => this.metrics(s.organizationId, now)));
      const lab = (m: EsfMetrics) => ({ organization_id: m.organizationId, environment: m.environment });
      const g = (name: string, help: string, pick: (m: EsfMetrics) => number | null) => gauge(name, help, all.map((m) => [lab(m), pick(m)]));
      g('flowpos_esf_session_open', 'Открыта ли сессия ИС ЭСФ (1/0)', (m) => (m.sessionOpen ? 1 : 0));
      g('flowpos_esf_last_success_sync_age_seconds', 'Секунд с последней успешной синхронизации', (m) => m.syncOkAgeSec);
      g('flowpos_esf_sync_failures', 'Неудачных синхронизаций подряд', (m) => m.syncFailures);
      g('flowpos_esf_cursor_lag_seconds', 'Отставание курсора входящих', (m) => m.cursorLagSec);
      g('flowpos_esf_unknown_count', 'ЭСФ с неизвестным результатом отправки', (m) => m.unknownCount);
      g('flowpos_esf_unknown_oldest_age_seconds', 'Возраст старейшего UNKNOWN', (m) => m.unknownOldestAgeSec);
      g('flowpos_esf_sending_lease_expired', 'Отправок дольше аренды', (m) => m.sendingStuck);
      g('flowpos_esf_quarantine_count', 'Входящих в карантине (открытых)', (m) => m.quarantineCount);
      g('flowpos_esf_quarantine_conflicts', 'Из них конфликтов с реестром (то же ЭСФ — другое содержимое; тот же номер)', (m) => m.quarantineConflicts);
      g('flowpos_esf_ready_count', 'Готовых к отправке', (m) => m.readyCount);
      g('flowpos_esf_rejected_24h', 'Отклонено ИС ЭСФ за сутки', (m) => m.rejected24h);
      g('flowpos_esf_signing_failures_24h', 'Отказов проверки подписи за сутки', (m) => m.signingFailures24h);
      g('flowpos_esf_decisions_overdue', 'Просроченных решений', (m) => m.decisionsOverdue);
      const open = await this.prisma.opsAlert.groupBy({ by: ['severity'], where: { resolvedAt: null }, _count: true });
      gauge('flowpos_ops_alerts_open', 'Открытых оповещений', ['WARNING', 'CRITICAL'].map((sv) => [{ severity: sv }, open.find((o) => o.severity === sv)?._count ?? 0]));
      const outbox = await this.prisma.outbox.groupBy({ by: ['status'], _count: true });
      gauge('flowpos_outbox_messages', 'Сообщения outbox по статусам (очередь в 1С)', outbox.map((o) => [{ status: o.status }, o._count]));
      const expired = await this.prisma.outbox.count({ where: { status: 'SENDING', leaseUntil: { lt: now } } });
      gauge('flowpos_outbox_lease_expired', 'Outbox: аренда истекла, а статус SENDING', [[{}, expired]]);
      const tick = EsfMonitorService.lastTickAt;
      gauge('flowpos_esf_worker_last_tick_age_seconds', 'Секунд с последнего прохода фоновой обработки ЭСФ в этом процессе', [[{}, tick ? Math.round((now.getTime() - tick.getTime()) / 1000) : null]]);
      return lines.join('\n').replace(/\{\}/g, '') + '\n';
    });
  }
}
