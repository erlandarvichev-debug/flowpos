// Подписки организации на решения платформы. Чистая логика без БД — проверяется модульными тестами.

/** Три направления платформы, каждое подключается отдельно. */
export const SOLUTIONS = ['trade', 'accounting', 'supervisor'] as const;
export type Solution = (typeof SOLUTIONS)[number];

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'suspended'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Короткие названия — для меню и сообщений. */
export const SOLUTION_NAMES: Record<Solution, string> = { trade: 'Учётная система', accounting: 'Бухгалтерия', supervisor: 'Супервайзер' };

export const SOLUTION_LABELS: Record<Solution, string> = {
  trade: 'Учётная система (продажи, покупки, склад, розница, справочники)',
  accounting: 'Бухгалтерия (банк и касса, ОС, зарплата и кадры, налоги, отчётность)',
  supervisor: 'Супервайзер (торговые представители)',
};

export interface SubscriptionRow {
  solution: string;
  status: string;
  validUntil: Date | null;
  seats: number | null;
}

export interface SolutionState {
  solution: Solution;
  enabled: boolean;
  status: SubscriptionStatus | 'none';
  validUntil: string | null;
  seats: number | null;
  /** Почему выключено — для понятного отказа. */
  reason?: string;
}

/** Решения, которые у организации без строки подписки включены: так работали все до подписок. */
export const ON_BY_DEFAULT: readonly Solution[] = ['trade', 'accounting'];

/**
 * «Учётная система» и «Бухгалтерия» включены, пока их явно не приостановили: у существующих организаций строки
 * подписки нет, и у них ничего не должно пропасть. «Супервайзер» — только с подпиской trial/active и неистёкшим сроком.
 */
export function solutionState(solution: Solution, row: SubscriptionRow | null | undefined, now = new Date()): SolutionState {
  const base = { solution, validUntil: row?.validUntil ? row.validUntil.toISOString() : null, seats: row?.seats ?? null };
  if (!row) {
    return ON_BY_DEFAULT.includes(solution)
      ? { ...base, enabled: true, status: 'none' }
      : { ...base, enabled: false, status: 'none', reason: 'Решение не подключено' };
  }
  const status = (SUBSCRIPTION_STATUSES as readonly string[]).includes(row.status) ? (row.status as SubscriptionStatus) : 'suspended';
  if (status === 'suspended') return { ...base, enabled: false, status, reason: 'Подписка приостановлена' };
  if (row.validUntil && row.validUntil.getTime() < now.getTime()) {
    return { ...base, enabled: false, status, reason: `Срок подписки истёк ${row.validUntil.toISOString().slice(0, 10)}` };
  }
  return { ...base, enabled: true, status };
}

export function allSolutionStates(rows: SubscriptionRow[], now = new Date()): Record<Solution, SolutionState> {
  const out = {} as Record<Solution, SolutionState>;
  for (const s of SOLUTIONS) out[s] = solutionState(s, rows.find((r) => r.solution === s), now);
  return out;
}

export interface SubscriptionInput {
  status: SubscriptionStatus;
  validUntil: Date | null;
  seats: number | null;
  note: string | null;
}

/** Проверка изменения подписки из админки платформы. Ошибка — текстом для человека. */
export function parseSubscriptionInput(body: any): SubscriptionInput {
  const status = String(body?.status ?? '');
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) throw new Error('Статус: trial, active или suspended');
  let validUntil: Date | null = null;
  if (body?.validUntil) {
    const s = String(body.validUntil);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Срок — дата в виде ГГГГ-ММ-ДД');
    // Действует до конца указанного дня по времени Казахстана (UTC+5).
    validUntil = new Date(`${s}T23:59:59.999+05:00`);
    if (Number.isNaN(validUntil.getTime())) throw new Error('Неверная дата срока');
  }
  let seats: number | null = null;
  if (body?.seats !== undefined && body?.seats !== null && body?.seats !== '') {
    seats = Number(body.seats);
    if (!Number.isInteger(seats) || seats < 0 || seats > 10000) throw new Error('Число мест — целое от 0 до 10000');
  }
  const note = body?.note ? String(body.note).slice(0, 500) : null;
  return { status: status as SubscriptionStatus, validUntil, seats, note };
}

export const isSolution = (v: unknown): v is Solution => (SOLUTIONS as readonly unknown[]).includes(v);
