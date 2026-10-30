// Статусы ЭСФ (FlowPOS и ИС ЭСФ): подпись и цвет — общие для списка и карточки.
export const STATUS: Record<string, [string, string]> = {
  READY: ['Готов к подписи', 'info'], SENT: ['Отправлен', ''], REJECTED: ['Отклонён (ФЛК)', 'danger'], CANCELLED: ['Отменён', 'info'],
  SENDING: ['Отправляется', 'warning'], UNKNOWN: ['Результат неизвестен — сверка', 'warning'],
  CREATED: ['Создан', ''], DELIVERED: ['Доставлен', 'success'], REVOKED: ['Отозван', 'warning'], DECLINED: ['Отклонён получателем', 'danger'],
  CANCELED: ['Аннулирован', 'warning'], IN_QUEUE: ['В очереди', ''], IN_PROCESSING: ['В обработке', ''], FAILED: ['Ошибочный', 'danger'],
  WAITING_CUSTOMER_CONFIRMATION: ['Ждёт подтверждения', 'warning'], WAITING_CUSTOMER_REVOKE_CONFIRMATION: ['Отзыв ждёт подтверждения', 'warning'],
}

export const statusText = (code?: string | null) => (code ? STATUS[code]?.[0] ?? code : '—')
