/** Единые форматы чисел и дат на всех экранах (раньше formatMoney был написан в 8 местах по-разному). */

const toNum = (v: unknown): number => (v === null || v === undefined || v === '' ? NaN : Number(v))

/** Деньги: «1 234 567,89» (копейки — только если есть). */
export function fmtMoney(v: unknown, digits: 0 | 2 | 'auto' = 'auto'): string {
  const n = toNum(v)
  if (!Number.isFinite(n)) return '—'
  const frac = digits === 'auto' ? (Math.round(n * 100) % 100 === 0 ? 0 : 2) : digits
  return n.toLocaleString('ru-RU', { minimumFractionDigits: frac, maximumFractionDigits: frac })
}

/** Деньги со знаком валюты: «1 234 ₸». */
export const fmtTenge = (v: unknown) => (Number.isFinite(toNum(v)) ? `${fmtMoney(v)} ₸` : '—')

/** Количество: до 3 знаков, без лишних нулей. */
export function fmtQty(v: unknown): string {
  const n = toNum(v)
  return Number.isFinite(n) ? n.toLocaleString('ru-RU', { maximumFractionDigits: 3 }) : '—'
}

/** Дата ДД.ММ.ГГГГ по Казахстану (UTC+5) — из ISO-строки, Date или ГГГГ-ММ-ДД. */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)}`
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const k = new Date(d.getTime() + 5 * 3600e3).toISOString()
  return `${k.slice(8, 10)}.${k.slice(5, 7)}.${k.slice(0, 4)}`
}

/** Дата и время ДД.ММ.ГГГГ ЧЧ:ММ по Казахстану. */
export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  const k = new Date(d.getTime() + 5 * 3600e3).toISOString()
  return `${k.slice(8, 10)}.${k.slice(5, 7)}.${k.slice(0, 4)} ${k.slice(11, 16)}`
}

/** Сегодня по Казахстану ГГГГ-ММ-ДД. */
export const kzToday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)

/** Сдвиг даты ГГГГ-ММ-ДД на n дней. */
export const shiftDay = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10)

/** Склонение: plural(5, 'документ', 'документа', 'документов'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
}
