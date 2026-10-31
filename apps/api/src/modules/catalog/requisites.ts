// FP-026: реквизиты контрагента — ИИН/БИН, IBAN, БИК, КБе — и выбор записи, действующей на дату (чистые функции).

export class RequisiteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Контрольный разряд ИИН/БИН РК: веса 1..11, сумма по модулю 11; если 10 — веса 3..11,1,2; если снова 10 —
 * номер недействителен.
 */
export function binCheckDigit(first11: string): number | null {
  const d = first11.split('').map(Number);
  const sum = (w: number[]) => d.reduce((s, x, i) => s + x * w[i], 0) % 11;
  let c = sum([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  if (c === 10) c = sum([3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2]);
  return c === 10 ? null : c;
}

export function binValid(v: string): boolean {
  if (!/^\d{12}$/.test(v)) return false;
  const c = binCheckDigit(v.slice(0, 11));
  return c !== null && c === Number(v[11]);
}

/** ИИН/БИН: 12 цифр с верным контрольным разрядом. Пробелы и дефисы из копирования убираются. */
export function validateBin(raw: unknown): string {
  const v = String(raw ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(v)) throw new RequisiteError('BIN_FORMAT', 'ИИН/БИН — 12 цифр');
  if (!binValid(v)) throw new RequisiteError('BIN_CHECK_DIGIT', `ИИН/БИН ${v}: неверный контрольный разряд — проверьте номер`);
  return v;
}

/** IBAN: латиница и цифры, контроль по модулю 97 (ISO 13616); казахстанский — KZ и 20 символов. */
export function validateIban(raw: unknown): string {
  const v = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) throw new RequisiteError('IBAN_FORMAT', 'IBAN: две буквы страны, две цифры и номер счёта (например, KZ…)');
  if (v.startsWith('KZ') && v.length !== 20) throw new RequisiteError('IBAN_FORMAT', 'IBAN Казахстана — 20 символов');
  const moved = v.slice(4) + v.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  if (rem !== 1) throw new RequisiteError('IBAN_CHECK', `IBAN ${v}: контрольные цифры не сходятся — проверьте номер счёта`);
  return v;
}

/** БИК банка (SWIFT-формат): 8 или 11 символов. */
export function validateBik(raw: unknown): string {
  const v = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v)) throw new RequisiteError('BIK_FORMAT', 'БИК — 8 символов (например, HSBKKZKX)');
  return v;
}

/** КБе: признак резидентства (1 — резидент, 2 — нерезидент) и сектор экономики (1–9). */
export function validateKbe(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!/^[12][1-9]$/.test(v)) throw new RequisiteError('KBE_FORMAT', 'КБе — две цифры: 1 резидент / 2 нерезидент и сектор экономики 1–9 (например, 17)');
  return v;
}

/** Дата без времени (UTC полночь) из 'YYYY-MM-DD' или Date. */
export function day(v: unknown): Date {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RequisiteError('DATE_FORMAT', 'Дата — в формате ГГГГ-ММ-ДД');
  const d = new Date(`${s}T00:00:00.000Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new RequisiteError('DATE_FORMAT', `Нет такой даты: ${s}`);
  return d;
}

/** Действует ли запись на дату: validFrom ≤ дата и (validTo пуст или ≥ дата). */
export function effectiveOn<T extends { validFrom: Date; validTo: Date | null }>(rows: T[], on: Date): T[] {
  const t = on.getTime();
  return rows.filter((r) => r.validFrom.getTime() <= t && (!r.validTo || r.validTo.getTime() >= t));
}

/**
 * Договор действует на дату документа: начало — startDate или дата договора, конец — endDate (пусто — бессрочно).
 * null — действует; иначе текст для пользователя.
 */
export function contractPeriodProblem(c: { number: string; startDate: Date | null; date: Date | null; endDate: Date | null }, at: Date): string | null {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = c.startDate ?? c.date;
  if ((from && iso(at) < iso(from)) || (c.endDate && iso(at) > iso(c.endDate))) {
    return `Договор № ${c.number} на ${iso(at)} не действует (срок: ${from ? iso(from) : '…'} — ${c.endDate ? iso(c.endDate) : 'бессрочно'})`;
  }
  return null;
}
