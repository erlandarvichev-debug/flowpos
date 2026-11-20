// Общее для экранов панели управления платформой.

export const STATUS: Record<string, string> = { none: 'не подключено', trial: 'пробная', active: 'действует', suspended: 'приостановлена' }

export const ROLES: Record<string, string> = {
  owner: 'Владелец', admin: 'Администратор', chief_accountant: 'Главный бухгалтер', accountant: 'Бухгалтер', hr: 'Кадровик',
  cashier: 'Кассир', storekeeper: 'Кладовщик', manager: 'Руководитель', auditor: 'Аудитор', supervisor: 'Супервайзер',
}

export const ACTIONS: Record<string, string> = {
  SUBSCRIPTION_SET: 'Подписка изменена',
  PLATFORM_ADMIN_ADDED: 'Назначен администратор платформы',
  PLATFORM_ADMIN_REMOVED: 'Снят администратор платформы',
  SELF_SIGNUP: 'Компания зарегистрировалась на сайте',
}

const kz = (v: string | Date) => new Date(new Date(v).getTime() + 5 * 3600 * 1000).toISOString()

/** Дата по времени Казахстана: ДД.ММ.ГГГГ */
export function fmtDay(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const iso = kz(v)
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}

/** Дата и время по времени Казахстана: ДД.ММ.ГГГГ ЧЧ:ММ */
export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const iso = kz(v)
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`
}

/** «5 мин назад», «3 ч назад», «вчера», иначе дата. */
export function ago(v: string | Date | null | undefined, now = Date.now()): string {
  if (!v) return 'никогда'
  const s = Math.max(0, Math.round((now - new Date(v).getTime()) / 1000))
  if (s < 60) return 'только что'
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`
  if (s < 2 * 86400) return 'вчера'
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} дн. назад`
  return fmtDay(v)
}

/** Состояние подписки из журнала: «действует · без срока · мест 5 · примечание». */
export function describeSub(a: any): string {
  if (!a) return 'не было'
  return [STATUS[a.status] || a.status, a.validUntil ? `до ${fmtDay(a.validUntil)}` : 'без срока', a.seats != null ? `мест ${a.seats}` : null, a.note]
    .filter(Boolean).join(' · ')
}

/** Подпись состояния решения у организации. */
export function solutionLabel(s: any, onByDefault: boolean): string {
  if (s.status === 'none') return onByDefault ? 'включено (по умолчанию)' : 'не подключено'
  return s.enabled ? STATUS[s.status] : `${STATUS[s.status]} · выключено`
}

export function solutionTag(s: any): 'success' | 'warning' | 'info' {
  return s.enabled ? (s.status === 'trial' ? 'warning' : 'success') : 'info'
}
