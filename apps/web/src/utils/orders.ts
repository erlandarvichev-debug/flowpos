/** Статусы заказов: этапы ставит человек, «частично / отгружен / получен / закрыт» считает сервер. */
export const ORDER_STATUS: Record<string, { label: string; type: 'info' | 'primary' | 'warning' | 'success' | 'danger' }> = {
  NEW: { label: 'Новый', type: 'info' },
  CONFIRMED: { label: 'Подтверждён', type: 'primary' },
  ASSEMBLING: { label: 'Собирается', type: 'warning' },
  ASSEMBLED: { label: 'Собран', type: 'warning' },
  SENT: { label: 'Отправлен поставщику', type: 'primary' },
  PARTLY_SHIPPED: { label: 'Отгружен частично', type: 'warning' },
  SHIPPED: { label: 'Отгружен', type: 'success' },
  PARTLY_RECEIVED: { label: 'Получен частично', type: 'warning' },
  RECEIVED: { label: 'Получен', type: 'success' },
  CLOSED: { label: 'Закрыт', type: 'info' },
}
/** Этапы, которые можно поставить вручную, по виду заказа (как на сервере). */
export const ORDER_STAGES: Record<string, string[]> = {
  CUSTOMER_ORDER: ['NEW', 'CONFIRMED', 'ASSEMBLING', 'ASSEMBLED'],
  PURCHASE_ORDER: ['NEW', 'SENT', 'CONFIRMED'],
}
export const isOrderType = (t: string) => t === 'CUSTOMER_ORDER' || t === 'PURCHASE_ORDER'
/** Статус, при котором заказ уже исполнен или закрыт — дата отгрузки больше не «горит». */
export const ORDER_DONE = new Set(['SHIPPED', 'RECEIVED', 'CLOSED'])
