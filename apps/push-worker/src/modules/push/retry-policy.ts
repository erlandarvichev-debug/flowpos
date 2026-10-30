// FP-021: что делать после неудачной попытки отправки в 1С. Чистые функции — без БД и сети.
//
// Главное правило: повторяем только то, что доказуемо не дошло до 1С или чей повтор безопасен.
// Запрос, который мог дойти (таймаут после отправки, обрыв, 5xx), без подтверждённой идемпотентности 1С
// не повторяется: статус UNKNOWN, решает оператор после сверки (ТЗ: «RETRYABLE относится к доказанному
// безопасному этапу»; «Истёкший lease не доказывает неотправку»).

export type Outcome =
  | { kind: 'RETRY'; delayMs: number; reason: string }
  | { kind: 'UNKNOWN'; reason: string }
  | { kind: 'DEAD'; reason: string };

export const BASE_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 12 * 60 * 60_000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
export const MAX_ATTEMPTS = 12;

/** Ошибки, при которых соединение не установлено — запрос заведомо не отправлен. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);

/** Retry-After: секунды или HTTP-дата (RFC 9110). Нет/неверно — null; не больше суток. */
export function parseRetryAfter(value: unknown, nowMs = Date.now()): number | null {
  if (value == null || value === '') return null;
  const s = String(Array.isArray(value) ? value[0] : value).trim();
  let ms: number;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else {
    const at = Date.parse(s);
    if (Number.isNaN(at)) return null;
    ms = at - nowMs;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Экспоненциальная задержка с полным jitter (равномерно 0…потолок), но не меньше Retry-After. */
export function backoffMs(attempt: number, retryAfterMs: number | null = null, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * ceiling);
  return Math.max(jittered, retryAfterMs ?? 0, 1000);
}

/**
 * Решение по ошибке попытки.
 * @param attempt номер этой попытки (1…)
 * @param idempotentSafe повтор этой операции безопасен (1С подтверждённо идемпотентна по ключу)
 */
export function classify(err: any, attempt: number, idempotentSafe: boolean, random: () => number = Math.random, nowMs = Date.now()): Outcome {
  const status: number | undefined = err?.response?.status;
  const code: string | undefined = err?.code;
  const retryAfter = parseRetryAfter(err?.response?.headers?.['retry-after'], nowMs);
  const msg = String(err?.message ?? err).slice(0, 300);
  const retry = (reason: string): Outcome =>
    attempt >= MAX_ATTEMPTS ? { kind: 'DEAD', reason: `${reason}; попыток: ${attempt}` } : { kind: 'RETRY', delayMs: backoffMs(attempt, retryAfter, random), reason };

  if (status === undefined) {
    if (code && NOT_SENT_CODES.has(code)) return retry(`запрос не отправлен (${code})`);
    // Таймаут/обрыв после установки соединения: 1С могла принять запрос.
    return idempotentSafe ? retry(`ответ не получен (${code ?? msg}), повтор идемпотентен`) : { kind: 'UNKNOWN', reason: `ответ не получен (${code ?? msg}) — 1С могла принять запрос` };
  }
  // Сервер явно просит подождать: запрос не обработан.
  if (status === 429 || (status === 503 && retryAfter != null)) return retry(`${status}: 1С просит повторить позже`);
  if (status >= 500) {
    return idempotentSafe ? retry(`${status}, повтор идемпотентен`) : { kind: 'UNKNOWN', reason: `${status} от 1С — результат неизвестен` };
  }
  // 4xx — ошибка запроса/доступа: повтор того же не поможет.
  return { kind: 'DEAD', reason: `${status}: ${err?.response?.data?.message ?? msg}` };
}
