// «Супервайзер»: общие подписи, форматы и загрузки для экранов раздела «Торговые».
import api from '@/api/client'

export const PLACEMENT: Record<string, { label: string; tag: 'success' | 'warning' | 'info' }> = {
  on_site: { label: 'На точке', tag: 'success' },
  remote: { label: 'Удалённо', tag: 'warning' },
  unknown: { label: 'Не определено', tag: 'info' },
}

export const TASK_STATUS: Record<string, { label: string; tag: 'success' | 'info' | 'danger' | 'primary' }> = {
  open: { label: 'Открыто', tag: 'primary' },
  done: { label: 'Выполнено', tag: 'success' },
  cancelled: { label: 'Отменено', tag: 'info' },
}

/** Сегодня по Казахстану (UTC+5), ГГГГ-ММ-ДД. */
export function kzToday(): string {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Время по Казахстану ЧЧ:ММ. */
export function kzTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  return new Date(new Date(v).getTime() + 5 * 3600 * 1000).toISOString().slice(11, 16)
}

/** Дата и время по Казахстану ДД.ММ ЧЧ:ММ. */
export function kzDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const iso = new Date(new Date(v).getTime() + 5 * 3600 * 1000).toISOString()
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}`
}

export function fmtDistance(m: number | null | undefined): string {
  if (m == null) return '—'
  return m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(1)} км`
}

export function fmtDuration(from: string | null, to: string | null): string {
  if (!from || !to) return '—'
  const min = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000))
  return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`
}

export function fmtSum(v: any): string {
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₸' : '—'
}

export interface Rep { id: string; name: string; phone?: string | null; isActive: boolean; moyskladLogin?: string | null; devices?: any[] }

export async function loadReps(): Promise<Rep[]> {
  const r = (await api.get('/field/reps')) as any
  return r.reps as Rep[]
}

/** Фото приходит только с токеном входа — поэтому файлом через API, а не ссылкой в <img>. */
const photoCache = new Map<string, string>()
export async function photoUrl(id: string): Promise<string> {
  const cached = photoCache.get(id)
  if (cached) return cached
  const blob = (await api.get(`/field/photos/${id}`, { responseType: 'blob' })) as unknown as Blob
  const url = URL.createObjectURL(blob)
  photoCache.set(id, url)
  return url
}

/** Свой цвет у каждого торгового — на карте и в списке (по порядку в списке, не случайно). */
export const REP_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f', '#c026d3', '#0f766e']
export const repColor = (i: number) => REP_COLORS[((i % REP_COLORS.length) + REP_COLORS.length) % REP_COLORS.length]

/** Инициалы для метки торгового на карте: «Асхат Нуров» → «АН». */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

/** Сколько прошло: «5 мин», «1 ч 40 мин». */
export function fmtAgo(v: string | Date | null | undefined, now = Date.now()): string {
  if (!v) return '—'
  const min = Math.max(0, Math.round((now - new Date(v).getTime()) / 60000))
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  if (min < 24 * 60) return `${Math.floor(min / 60)} ч ${min % 60} мин назад`
  return `${Math.floor(min / 1440)} дн назад`
}

/** Изменение к прошлому периоду в процентах; null — сравнивать не с чем. */
export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0
  return Math.round(((cur - prev) / prev) * 1000) / 10
}

/** Дата по Казахстану со сдвигом в днях (ГГГГ-ММ-ДД). */
export function kzShift(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10)
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`
}
