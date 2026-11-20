// Один собранный сайт обслуживает два адреса:
//   flowpos.kz     — рабочее место клиентов;
//   ad.flowpos.kz  — панель управления платформой (только администраторы платформы).
// Для проверки на своём компьютере панель открывается на ad.localhost:5173.

export const isAdminHost = typeof location !== 'undefined' && /^ad\./i.test(location.hostname)

/** Адрес панели управления для текущего сайта (null — неизвестно, куда вести). */
export function adminUrl(): string | null {
  if (typeof location === 'undefined') return null
  const host = location.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1') return `${location.protocol}//ad.localhost${location.port ? `:${location.port}` : ''}/`
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !host.startsWith('ad.')) return `https://ad.${host.replace(/^www\./, '')}/`
  return null
}

/** Адрес рабочего места клиентов — для ссылки из панели управления. */
export function appUrl(): string {
  if (typeof location === 'undefined') return '/'
  return `${location.protocol}//${location.host.replace(/^ad\./i, '')}/`
}
