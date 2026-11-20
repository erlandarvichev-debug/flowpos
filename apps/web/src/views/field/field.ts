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
