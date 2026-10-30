import { BASE_DELAY_MS, MAX_ATTEMPTS, MAX_DELAY_MS, backoffMs, classify, parseRetryAfter } from './retry-policy';

const http = (status: number, headers: Record<string, string> = {}) => ({ message: `HTTP ${status}`, response: { status, headers, data: {} } });
const net = (code: string) => ({ message: code, code });
const fixed = (x: number) => () => x;

describe('FP-021: Retry-After', () => {
  it('секунды, HTTP-дата, мусор, предел в сутки', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Fri, 30 Oct 2026 12:05:00 GMT', now)).toBe(300_000);
    expect(parseRetryAfter('Fri, 30 Oct 2026 11:00:00 GMT', now)).toBe(0); // в прошлом
    expect(parseRetryAfter('скоро', now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter(String(7 * 86400), now)).toBe(86_400_000);
  });
});

describe('FP-021: backoff с полным jitter', () => {
  it('равномерно от 0 до потолка 60с·2^(n-1), потолок 12 ч, не меньше Retry-After', () => {
    expect(backoffMs(1, null, fixed(0.5))).toBe(BASE_DELAY_MS / 2);
    expect(backoffMs(3, null, fixed(0.999999))).toBe(Math.floor(0.999999 * BASE_DELAY_MS * 4));
    expect(backoffMs(30, null, fixed(0.999999))).toBe(Math.floor(0.999999 * MAX_DELAY_MS));
    expect(backoffMs(1, 600_000, fixed(0.1))).toBe(600_000);
    expect(backoffMs(1, null, fixed(0))).toBe(1000); // не ноль: без горячего цикла
  });

  it('разброс у разных воркеров (не синхронный шторм)', () => {
    const values = new Set(Array.from({ length: 50 }, () => backoffMs(5)));
    expect(values.size).toBeGreaterThan(40);
  });
});

describe('FP-021: решение по ошибке', () => {
  it('не отправлено (нет соединения) — повтор', () => {
    expect(classify(net('ECONNREFUSED'), 1, false, fixed(0.5))).toMatchObject({ kind: 'RETRY' });
    expect(classify(net('ENOTFOUND'), 1, false, fixed(0.5))).toMatchObject({ kind: 'RETRY' });
  });

  it('ответ потерян после отправки (таймаут, обрыв, 5xx) — UNKNOWN без повтора, если идемпотентность не подтверждена', () => {
    for (const e of [net('ECONNABORTED'), net('ETIMEDOUT'), net('ECONNRESET'), http(500), http(502), http(503)]) {
      expect(classify(e, 1, false).kind).toBe('UNKNOWN');
    }
    expect(classify(http(500), 1, true, fixed(0.5)).kind).toBe('RETRY');
    expect(classify(net('ECONNRESET'), 1, true, fixed(0.5)).kind).toBe('RETRY');
  });

  it('429 и 503 с Retry-After — повтор не раньше указанного', () => {
    const r = classify(http(429, { 'retry-after': '300' }), 1, false, fixed(0));
    expect(r).toMatchObject({ kind: 'RETRY', delayMs: 300_000 });
    expect(classify(http(503, { 'retry-after': '30' }), 1, false, fixed(0))).toMatchObject({ kind: 'RETRY', delayMs: 30_000 });
  });

  it('4xx — в DLQ сразу; исчерпаны попытки — в DLQ', () => {
    expect(classify(http(400), 1, false).kind).toBe('DEAD');
    expect(classify(http(401), 1, false).kind).toBe('DEAD');
    expect(classify(http(422), 1, false).kind).toBe('DEAD');
    expect(classify(net('ECONNREFUSED'), MAX_ATTEMPTS, false).kind).toBe('DEAD');
  });
});
