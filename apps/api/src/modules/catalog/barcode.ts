// FP-025: штрихкоды — нормализация, тип, контрольная цифра GS1, разбор весового штрихкода (чистые функции).

export type BarcodeKind = 'EAN13' | 'EAN8' | 'UPCA' | 'GTIN14' | 'CODE128';
export const BARCODE_KINDS: BarcodeKind[] = ['EAN13', 'EAN8', 'UPCA', 'GTIN14', 'CODE128'];
const GS1_LENGTH: Partial<Record<BarcodeKind, number>> = { EAN8: 8, UPCA: 12, EAN13: 13, GTIN14: 14 };

export class BarcodeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Пробелы и переводы строк (сканер, копирование из таблицы) убираются; остальное — как есть. */
export function normalizeBarcode(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, '');
}

/** Контрольная цифра GS1 для строки без неё (веса 3,1,3,… справа налево). */
export function gs1CheckDigit(data: string): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += Number(data[data.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function gs1Valid(code: string): boolean {
  return /^\d{8,14}$/.test(code) && gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** Тип по содержимому: цифровой код верной длины с верной контрольной цифрой — GS1, иначе — Code 128. */
export function detectKind(code: string): BarcodeKind {
  if (gs1Valid(code)) {
    const k = (Object.keys(GS1_LENGTH) as BarcodeKind[]).find((x) => GS1_LENGTH[x] === code.length);
    if (k) return k;
  }
  return 'CODE128';
}

/**
 * Проверка штрихкода при ручном вводе. Явно указанный тип GS1 проверяется строго (длина и контрольная цифра):
 * опечатка в EAN не должна молча стать «внутренним кодом». Без типа — определяется по содержимому.
 */
export function validateBarcode(raw: unknown, kind?: string | null): { barcode: string; kind: BarcodeKind } {
  const barcode = normalizeBarcode(raw);
  if (!barcode) throw new BarcodeError('BARCODE_EMPTY', 'Штрихкод пустой');
  if (barcode.length > 64) throw new BarcodeError('BARCODE_TOO_LONG', 'Штрихкод длиннее 64 символов');
  if (!/^[\x21-\x7E]+$/.test(barcode)) throw new BarcodeError('BARCODE_CHARS', 'Штрихкод может содержать только латиницу, цифры и знаки (без кириллицы)');
  if (!kind) return { barcode, kind: detectKind(barcode) };
  if (!BARCODE_KINDS.includes(kind as BarcodeKind)) throw new BarcodeError('BARCODE_KIND', `Тип штрихкода: ${BARCODE_KINDS.join(', ')}`);
  const len = GS1_LENGTH[kind as BarcodeKind];
  if (len) {
    if (!new RegExp(`^\\d{${len}}$`).test(barcode)) throw new BarcodeError('BARCODE_FORMAT', `${kind}: нужно ровно ${len} цифр`);
    if (!gs1Valid(barcode)) {
      throw new BarcodeError('BARCODE_CHECK_DIGIT', `${kind}: неверная контрольная цифра (последняя должна быть ${gs1CheckDigit(barcode.slice(0, -1))}). Проверьте код или выберите тип CODE128 для внутреннего кода`);
    }
  }
  return { barcode, kind: kind as BarcodeKind };
}

/** Весовые штрихкоды клиента: EAN-13 = префикс(2) + код товара PLU(N) + вес в граммах(10−N) + контрольная. */
export interface WeightBarcodeSettings {
  prefixes: string[];
  pluLength: number;
}

export function validateWeightSettings(v: { prefixes?: unknown; pluLength?: unknown }): WeightBarcodeSettings {
  const prefixes = Array.isArray(v.prefixes) ? [...new Set(v.prefixes.map((p) => String(p).trim()))] : [];
  for (const p of prefixes) if (!/^2\d$/.test(p)) throw new BarcodeError('WEIGHT_PREFIX', `Префикс «${p}»: весовые штрихкоды — внутренние коды магазина 20–29`);
  const pluLength = Number(v.pluLength ?? 5);
  if (!Number.isInteger(pluLength) || pluLength < 4 || pluLength > 6) throw new BarcodeError('WEIGHT_PLU_LENGTH', 'Длина кода товара (PLU) — от 4 до 6 цифр');
  return { prefixes, pluLength };
}

/** Разбор весового штрихкода; null — это не весовой код (префикс не настроен, не EAN-13, неверная контрольная). */
export function parseWeightBarcode(code: string, s: WeightBarcodeSettings): { plu: string; grams: number; kg: string } | null {
  if (!s.prefixes.length || !/^\d{13}$/.test(code) || !s.prefixes.includes(code.slice(0, 2)) || !gs1Valid(code)) return null;
  const plu = code.slice(2, 2 + s.pluLength);
  const grams = Number(code.slice(2 + s.pluLength, 12));
  if (grams <= 0) return null;
  return { plu, grams, kg: (grams / 1000).toFixed(3) };
}

/** PLU весового товара: цифры, длина как в настройках клиента. */
export function validatePlu(raw: unknown, pluLength: number): string {
  const plu = String(raw ?? '').trim();
  if (!new RegExp(`^\\d{${pluLength}}$`).test(plu)) throw new BarcodeError('PLU_FORMAT', `Код весового товара (PLU) — ровно ${pluLength} цифр, как в настройках весовых штрихкодов`);
  return plu;
}
