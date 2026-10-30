import { ElMessageBox, ElNotification } from 'element-plus'
import api from '@/api/client'
import router from '@/router'

/** Деньги ru-KZ, 2 знака. Принимает строки Decimal без потерь для отображения. */
export function fmtMoney(v: any): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (!isFinite(n)) return String(v)
  return new Intl.NumberFormat('ru-KZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

export function fmtDate(v: any): string {
  if (!v) return ''
  return String(v).slice(0, 10).split('-').reverse().join('.')
}

/** Нормализация суммы из ввода в строку без float: «1 000,5» → «1000.5». */
export function normAmount(v: any): string {
  return String(v ?? '').replace(/\s/g, '').replace(',', '.')
}

/** Сложение строковых сумм в копейках (без потерь float). */
export function addMoney(values: any[]): string {
  let cents = 0n
  for (const raw of values) {
    const s = normAmount(raw)
    if (!/^-?\d+(\.\d{0,2})?$/.test(s)) continue
    const neg = s.startsWith('-')
    const [i, f = ''] = s.replace('-', '').split('.')
    const c = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2))
    cents += neg ? -c : c
  }
  const neg = cents < 0n
  const a = neg ? -cents : cents
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`
}

export function idem() {
  const key = (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { headers: { 'Idempotency-Key': key } }
}

/** Понятная ошибка: что произошло + что исправить + переход. */
export function showError(e: any) {
  const message = e?.message || 'Ошибка'
  // FP-022: код обращения — по нему поддержка найдёт запрос в журнале и логах.
  const fix = [e?.fix, e?.traceId ? `Код обращения: ${e.traceId}` : ''].filter(Boolean).join('\n\n') || undefined
  const link = e?.link
  if (link) {
    ElMessageBox.confirm(fix ? `${message}\n\n${fix}` : message, 'Ошибка', {
      confirmButtonText: 'Перейти', cancelButtonText: 'Закрыть', type: 'error',
    }).then(() => router.push(link)).catch(() => undefined)
  } else {
    ElNotification({ type: 'error', title: message, message: fix || '', duration: 8000 })
  }
}

export const DIM_LABELS: Record<string, string> = {
  COUNTERPARTY: 'Контрагент', CONTRACT: 'Договор', SETTLEMENT_DOC: 'Документ расчётов', PRODUCT: 'Номенклатура',
  STORE: 'Склад', EMPLOYEE: 'Сотрудник', DEPARTMENT: 'Подразделение', BANK_ACCOUNT: 'Банковский счёт',
  CASHBOX: 'Касса', PROJECT: 'Проект', ITEM: 'Статья',
}

export const DOC_TYPE_LABELS: Record<string, string> = {
  MANUAL_OPERATION: 'Операция (вручную)', OPENING_BALANCE: 'Ввод начальных остатков', STORNO: 'Сторно',
  BANK_IN: 'Поступление на расчётный счёт', BANK_OUT: 'Списание с расчётного счёта',
  CASH_IN: 'Приходный кассовый ордер', CASH_OUT: 'Расходный кассовый ордер',
}

export const MONEY_DOC_TYPES = ['BANK_IN', 'BANK_OUT', 'CASH_IN', 'CASH_OUT']

/** Торговые документы FlowPOS (таблица documents) — подписи ru/kk. */
export const TRADE_TYPES: Record<string, { ru: string; kk: string }> = {
  PURCHASE_ORDER: { ru: 'Заказ поставщику', kk: 'Жеткізушіге тапсырыс' },
  SUPPLY: { ru: 'Поступление товаров', kk: 'Тауарлардың түсуі' },
  PURCHASE_RETURN: { ru: 'Возврат поставщику', kk: 'Жеткізушіге қайтару' },
  CUSTOMER_ORDER: { ru: 'Заказ покупателя', kk: 'Сатып алушының тапсырысы' },
  DEMAND: { ru: 'Реализация', kk: 'Өткізу' },
  SALES_RETURN: { ru: 'Возврат от покупателя', kk: 'Сатып алушыдан қайтару' },
  ENTER: { ru: 'Оприходование', kk: 'Кіріске алу' },
  LOSS: { ru: 'Списание', kk: 'Есептен шығару' },
  MOVE: { ru: 'Перемещение', kk: 'Орын ауыстыру' },
  RETAIL_DEMAND: { ru: 'Розничный чек', kk: 'Бөлшек чек' },
  RETAIL_RETURN: { ru: 'Возврат по чеку', kk: 'Чек бойынша қайтару' },
  PAYMENT_IN: { ru: 'Входящий платёж (обмен)', kk: 'Кіріс төлем (алмасу)' },
  PAYMENT_OUT: { ru: 'Исходящий платёж (обмен)', kk: 'Шығыс төлем (алмасу)' },
  INVOICE_IN: { ru: 'Счёт поставщика', kk: 'Жеткізуші шоты' },
  INVOICE_OUT: { ru: 'Счёт покупателю', kk: 'Сатып алушыға шот' },
  INVENTORY: { ru: 'Инвентаризация', kk: 'Түгендеу' },
  RETAIL_SHIFT: { ru: 'Кассовая смена', kk: 'Кассалық ауысым' },
}
export const TRADE_CREATABLE = ['PURCHASE_ORDER', 'SUPPLY', 'PURCHASE_RETURN', 'CUSTOMER_ORDER', 'DEMAND', 'SALES_RETURN', 'ENTER', 'LOSS', 'MOVE', 'RETAIL_DEMAND', 'RETAIL_RETURN']
/** Создание на основании: тип основания → допустимые новые типы. */
export const BASE_TARGETS: Record<string, string[]> = { CUSTOMER_ORDER: ['DEMAND'], PURCHASE_ORDER: ['SUPPLY'], DEMAND: ['SALES_RETURN'], SUPPLY: ['PURCHASE_RETURN'] }

/** Ссылка на документ-источник проводки (бухгалтерский, торговый или запись себестоимости). */
export function sourceLink(src: { type?: string; id?: string; link?: string | null } | null | undefined): string | null {
  if (!src) return null
  if (src.link) return src.link
  if (src.type === 'TRADE_DOCUMENT' && src.id) return `/accounting/trade/${src.id}`
  if (src.type === 'COST' && src.id) {
    const [t, id] = src.id.split(':')
    if (t === 'TRADE_DOCUMENT' && id) return `/accounting/trade/${id}`
    if (t === 'ACC_DOCUMENT' && id) return `/accounting/documents/${id}`
  }
  if (src.type === 'ACC_DOCUMENT' && src.id) return `/accounting/documents/${src.id}`
  return null
}

/** Сумма строки в копейках: цена × количество − скидка %, округление половина вверх. */
export function lineTotal(qty: any, price: any, discount: any): string {
  const q = normAmount(qty), p = normAmount(price), d = normAmount(discount)
  if (!/^\d+(\.\d{0,3})?$/.test(q) || !/^\d+(\.\d{0,2})?$/.test(p)) return '0.00'
  const [qi, qf = ''] = q.split('.')
  const [pi, pf = ''] = p.split('.')
  const qMilli = BigInt(qi) * 1000n + BigInt((qf + '000').slice(0, 3))
  const pCents = BigInt(pi) * 100n + BigInt((pf + '00').slice(0, 2))
  let num = qMilli * pCents // в 1/1000 копейки
  if (/^\d+(\.\d{0,2})?$/.test(d) && d !== '') {
    const [di, df = ''] = d.split('.')
    const dHund = BigInt(di) * 100n + BigInt((df + '00').slice(0, 2)) // процент × 100
    num = num * (10000n - dHund) // делим потом на 10000
    const den = 1000n * 10000n
    const cents = (num * 2n + den) / (2n * den)
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
  }
  const cents = (num * 2n + 1000n) / 2000n
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

export const STATUS_TYPES: Record<string, string> = { DRAFT: 'info', POSTED: 'success', CANCELLED: 'danger' }

/** Загрузка вариантов для аналитики. search — для удалённого поиска. */
export async function loadDimOptions(dim: string, search = ''): Promise<{ value: string; label: string }[]> {
  const q = { params: { search: search || undefined, limit: 50 } }
  switch (dim) {
    case 'BANK_ACCOUNT': return ((await api.get('/accounting/refs/bank-accounts')) as any[]).map((x) => ({ value: x.id, label: `${x.name} (${x.iban})` }))
    case 'CASHBOX': return ((await api.get('/accounting/refs/cashboxes')) as any[]).map((x) => ({ value: x.id, label: x.name }))
    case 'PROJECT': return ((await api.get('/accounting/refs/projects')) as any[]).map((x) => ({ value: x.id, label: `${x.code} ${x.name}` }))
    case 'ITEM': return ((await api.get('/accounting/refs/items')) as any[]).map((x) => ({ value: x.id, label: `${x.code} ${x.name} · ${x.kind}` }))
    case 'STORE': return ((await api.get('/catalog/warehouses')) as any[]).map((x) => ({ value: x.id, label: x.name }))
    case 'COUNTERPARTY': return (((await api.get('/catalog/counterparties', q)) as any).counterparties || []).map((x: any) => ({ value: x.id, label: x.inn ? `${x.name} (${x.inn})` : x.name }))
    case 'PRODUCT': return (((await api.get('/catalog/items', q)) as any).items || []).map((x: any) => ({ value: x.id, label: x.code ? `${x.code} ${x.name}` : x.name }))
    case 'CONTRACT': return ((await api.get('/accounting/contracts')) as any[]).map((x) => ({ value: x.id, label: `Договор ${x.number}${x.name ? ' — ' + x.name : ''}` }))
    case 'EMPLOYEE': return (((await api.get('/hr/employees', q)) as any).employees || []).map((x: any) => ({ value: x.id, label: `${x.lastName} ${x.firstName}` }))
    default: return []
  }
}
