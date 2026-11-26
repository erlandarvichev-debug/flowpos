// Разделы меню рабочего места — один список и для бокового меню, и для страниц-плиток разделов (/section/<ключ>).
// Видимость решают подписки организации (учётная система, бухгалтерия, супервайзер) и права роли.

export interface MenuItem { path: string; title: string; desc: string; icon: string; badge?: 'autopilot' }
export interface MenuSection { key: string; title: string; icon: string; desc: string; items: MenuItem[] }

export interface MenuCtx {
  showTrade: boolean
  showAcc: boolean
  supervisor: boolean
  can: (perm: string) => boolean
}

/** Цвет раздела: иконки в меню, заголовках страниц и плитках. */
export const SECTION_TONES: Record<string, string> = {
  sales: '#1769e0', purchases: '#7c3aed', bank: '#23a047', warehouse: '#0891b2', production: '#ea580c', reports: '#0f766e',
  tasks: '#d97706', refs: '#475569', admin: '#64748b', field: '#db2777', pos: '#0d9488', operations: '#6366f1', tax: '#b45309',
  assets: '#78716c', hr: '#9333ea',
}

const when = <T>(cond: boolean, ...items: T[]): T[] => (cond ? items : [])

export function buildMenu(c: MenuCtx): MenuSection[] {
  const sections: MenuSection[] = [
    {
      key: 'field', title: 'Торговые', icon: 'Location', desc: 'Торговые представители «в полях»: маршруты, посещения с фото и местом, задания и заказы.',
      items: when(c.supervisor && c.can('field.read'),
        { path: '/field/day', title: 'Карта торговых', desc: 'Где торговые сейчас, их путь, маршрут, посещения и заказы за день', icon: 'MapLocation' },
        { path: '/field/sales', title: 'Продажи торговых', desc: 'Заказы за период: по торговым, клиентам, дням; кто перестал заказывать', icon: 'TrendCharts' },
        { path: '/field/visits', title: 'Посещения', desc: 'Кто, где и когда был: на точке или удалённо, фото, комментарии', icon: 'Camera' },
        { path: '/field/routes', title: 'Маршруты', desc: 'План объезда точек на день для каждого торгового', icon: 'Guide' },
        { path: '/field/tasks', title: 'Задания', desc: 'Поручения торговым: сфотографировать выкладку, узнать цены', icon: 'List' },
        { path: '/field/plan-fact', title: 'План и факт', desc: 'Сколько точек по маршруту посещено и сколько заказов', icon: 'DataLine' },
        { path: '/field/points', title: 'Точки', desc: 'Магазины-клиенты и их место на карте', icon: 'Shop' },
        { path: '/field/reps', title: 'Представители', desc: 'Торговые и привязка их телефонов к агенту', icon: 'Avatar' },
      ),
    },
    {
      key: 'sales', title: 'Продажи', icon: 'Sell', desc: 'Заказы покупателей, отгрузки, возвраты и цены.',
      items: when(c.showTrade,
        { path: '/sales/orders', title: 'Заказы покупателей', desc: 'Заказы от клиентов и торговых', icon: 'Tickets' },
        { path: '/sales/consignment', title: 'Товары на реализации', desc: 'Товар у комиссионеров: передать, отчёт о продажах, вернуть', icon: 'Van' },
        { path: '/sales/invoices', title: 'Счета покупателям', desc: 'Счета на оплату: оплачено, отгружено', icon: 'Document' },
        { path: '/sales/shipments', title: 'Реализации', desc: 'Отгрузки товаров покупателям', icon: 'Van' },
        { path: '/sales/returns', title: 'Возвраты от покупателей', desc: 'Возвраты товаров от клиентов', icon: 'RefreshLeft' },
        { path: '/sales/retail', title: 'Розничные продажи', desc: 'Продажи через кассы за смену', icon: 'ShoppingBag' },
        ...when(c.showAcc && c.can('acc.esf.read'), { path: '/accounting/esf', title: 'ЭСФ', desc: 'Электронные счета-фактуры', icon: 'Document' }),
        { path: '/catalog/pricing', title: 'Цены и скидки', desc: 'Прайс-листы, типы цен и скидки', icon: 'PriceTag' },
      ),
    },
    {
      key: 'purchases', title: 'Покупки', icon: 'ShoppingCart', desc: 'Заказы поставщикам и поступления товаров.',
      items: when(c.showTrade,
        { path: '/purchases/orders', title: 'Заказы поставщикам', desc: 'Что и у кого заказано', icon: 'Tickets' },
        { path: '/purchases/invoices', title: 'Счета поставщиков', desc: 'Входящие счета: что оплатить', icon: 'Document' },
        ...when(c.can('stock.read'), { path: '/accounting/purchase-needs', title: 'Потребность в закупках', desc: 'Чего не хватает на складе', icon: 'TrendCharts' }),
        { path: '/purchases/receipts', title: 'Поступления товаров', desc: 'Приход товаров от поставщиков', icon: 'Download' },
        { path: '/purchases/landed-costs', title: 'Доп. расходы', desc: 'Доставка и прочие расходы в себестоимость', icon: 'Coin' },
        { path: '/purchases/returns', title: 'Возвраты поставщикам', desc: 'Возврат товаров поставщику', icon: 'RefreshRight' },
      ),
    },
    {
      key: 'bank', title: 'Банк и касса', icon: 'Wallet', desc: 'Движение денег по счетам и кассе.',
      // Деньги нужны и учётной системе (оплаты по реализациям и поступлениям), не только бухгалтерии.
      items: when(c.showAcc || c.showTrade,
        { path: '/bank/statements', title: 'Банковские выписки', desc: 'Поступления и списания по счёту', icon: 'CreditCard' },
        { path: '/accounting/bank-import', title: 'Загрузка выписки', desc: 'Загрузить выписку из банка файлом', icon: 'Upload' },
        { path: '/bank/cash', title: 'Кассовые документы', desc: 'Приходные и расходные кассовые ордера', icon: 'Money' },
      ),
    },
    {
      key: 'warehouse', title: 'Склад', icon: 'Box', desc: 'Остатки и движение товаров.',
      items: when(c.showTrade,
        { path: '/trade/stocks', title: 'Остатки', desc: 'Сколько товара на каждом складе', icon: 'Box' },
        { path: '/warehouse/internal-orders', title: 'Внутренние заказы', desc: 'Заявки складов и магазинов на товар с другого склада', icon: 'Tickets' },
        ...when(c.can('stock.read'), { path: '/accounting/stock-movements', title: 'Движения товаров', desc: 'Приход и расход по каждому товару', icon: 'Sort' }),
        { path: '/warehouse/moves', title: 'Перемещения', desc: 'Перемещение между складами', icon: 'Switch' },
        { path: '/warehouse/entries', title: 'Оприходования и списания', desc: 'Излишки и недостачи', icon: 'EditPen' },
        { path: '/warehouse/inventories', title: 'Инвентаризации', desc: 'Пересчёт товаров на складе', icon: 'Checked' },
      ),
    },
    {
      key: 'assets', title: 'Основные средства', icon: 'OfficeBuilding', desc: 'ОС, НМА и амортизация.',
      items: when(c.showAcc,
        { path: '/assets', title: 'ОС и НМА', desc: 'Карточки основных средств и нематериальных активов', icon: 'OfficeBuilding' },
        { path: '/assets/depreciation', title: 'Амортизация', desc: 'Начисление амортизации за месяц', icon: 'TrendCharts' },
      ),
    },
    {
      key: 'pos', title: 'Розница (FlowPOS)', icon: 'Monitor', desc: 'Кассы FlowPOS, смены и чеки.',
      items: when(c.showTrade,
        { path: '/pos/terminals', title: 'Кассы', desc: 'Кассы магазинов', icon: 'Monitor' },
        { path: '/pos/shifts', title: 'Смены', desc: 'Открытые и закрытые смены', icon: 'Clock' },
        { path: '/sales/retail', title: 'Чеки', desc: 'Все чеки продаж и возвратов', icon: 'Tickets' },
      ),
    },
    {
      key: 'hr', title: 'Зарплата и кадры', icon: 'UserFilled', desc: 'Сотрудники, отпуска, зарплата и табель.',
      items: when(c.showAcc,
        { path: '/hr/staff', title: 'Сотрудники', desc: 'Карточки сотрудников и оклады', icon: 'User' },
        { path: '/hr/absences', title: 'Отпуска и больничные', desc: 'Отсутствия и средний заработок', icon: 'Calendar' },
        { path: '/hr/payroll-run', title: 'Расчёт зарплаты', desc: 'Начисление и удержания за месяц', icon: 'Money' },
        { path: '/hr/schedule', title: 'График смен', desc: 'Кто и когда работает', icon: 'Timer' },
        { path: '/hr/timesheet', title: 'Табель', desc: 'Учёт рабочего времени', icon: 'Grid' },
      ),
    },
    {
      key: 'production', title: 'Производство', icon: 'Odometer', desc: 'Техкарты и выпуск продукции из сырья.',
      items: when(c.showTrade, { path: '/production', title: 'Производство', desc: 'Техкарты, план и выпуск продукции, себестоимость', icon: 'Odometer' }),
    },
    {
      key: 'tasks', title: 'Задачи', icon: 'Finished', desc: 'Поручения сотрудникам со сроками.',
      items: when(c.can('acc.doc.read'), { path: '/tasks', title: 'Задачи', desc: 'Мои задачи, поставленные мной, просроченные', icon: 'Finished' }),
    },
    {
      key: 'operations', title: 'Операции', icon: 'Operation', desc: 'Ручные операции, автопилот, согласования и закрытие месяца.',
      items: when(c.showAcc,
        { path: '/operations/manual', title: 'Операции вручную', desc: 'Проводки, введённые вручную', icon: 'EditPen' },
        { path: '/accounting/autopilot', title: 'Автопилот', desc: 'Автоматическое проведение и найденные проблемы', icon: 'MagicStick', badge: 'autopilot' },
        ...when(c.can('acc.doc.read'), { path: '/accounting/approvals', title: 'Согласования', desc: 'Документы, ожидающие согласования', icon: 'Stamp' }),
        { path: '/accounting/closing', title: 'Закрытие месяца', desc: 'Регламентные операции месяца', icon: 'Lock' },
        { path: '/accounting/trade', title: 'Все торговые документы', desc: 'Журнал торговых документов', icon: 'Files' },
        { path: '/accounting/documents', title: 'Все документы учёта', desc: 'Журнал документов бухгалтерии', icon: 'Folder' },
      ),
    },
    {
      key: 'tax', title: 'Налоги', icon: 'Stamp', desc: 'Декларации, НДС, ЭСФ и налоговые регистры.',
      items: when(c.showAcc,
        { path: '/tax/declarations', title: 'Декларации', desc: 'Формы налоговой отчётности', icon: 'Document' },
        { path: '/tax/vat', title: 'Регистр НДС', desc: 'НДС к уплате и к зачёту', icon: 'Notebook' },
        { path: '/tax/simplified', title: 'Доходы для упрощёнки', desc: 'Доходы для упрощённой декларации', icon: 'Reading' },
        { path: '/tax/payroll', title: 'Налоги с зарплаты', desc: 'ИПН, соцналог и взносы', icon: 'Money' },
        ...when(c.can('acc.esf.read'), { path: '/accounting/esf', title: 'ЭСФ и зачёт НДС', desc: 'Входящие и исходящие ЭСФ', icon: 'Postcard' }),
        { path: '/tax/rules', title: 'Налоговые правила', desc: 'Ставки и правила расчёта', icon: 'SetUp' },
      ),
    },
    {
      key: 'reports', title: 'Отчёты', icon: 'DataAnalysis', desc: 'Бухгалтерские и торговые отчёты.',
      items: [
        ...when(c.showAcc, { path: '/accounting/reports/trial-balance', title: 'Оборотно-сальдовая ведомость', desc: 'Обороты и остатки по счетам', icon: 'Grid' }),
        ...when(c.showAcc, { path: '/accounting/reports/account-card', title: 'Карточка счёта', desc: 'Все проводки по счёту', icon: 'Postcard' }),
        ...when(c.showAcc, { path: '/accounting/reports/journal', title: 'Журнал проводок', desc: 'Все проводки за период', icon: 'Notebook' }),
        ...when(c.showTrade, { path: '/reports/money-flow', title: 'Движение денег', desc: 'Поступления и выплаты по статьям и месяцам', icon: 'Wallet' }),
        ...when(c.showTrade, { path: '/reports/stock-turnover', title: 'Обороты товаров', desc: 'Начало, приход, расход, конец по товарам', icon: 'Sort' }),
        ...when(c.showTrade, { path: '/reports/profitability', title: 'Прибыльность', desc: 'Прибыль и маржа по товарам, клиентам, сотрудникам', icon: 'Money' }),
        ...when(c.showTrade, { path: '/reports/debt-aging', title: 'Долги по срокам', desc: 'Просрочка покупателей и поставщикам', icon: 'Timer' }),
        ...when(c.showTrade, { path: '/accounting/reports/settlements', title: 'Взаиморасчёты', desc: 'Долги клиентов и поставщикам', icon: 'Connection' }),
        ...when(c.showTrade, { path: '/reports/reconciliation', title: 'Акт сверки', desc: 'Сверка расчётов с контрагентом', icon: 'DocumentChecked' }),
        ...when(c.showTrade, { path: '/accounting/reports/stock', title: 'Остатки и себестоимость', desc: 'Количество и стоимость товаров', icon: 'Box' }),
        ...when(c.showAcc, { path: '/accounting/statements', title: 'Финансовая отчётность', desc: 'Баланс и отчёт о прибылях', icon: 'PieChart' }),
        ...when(c.showTrade, { path: '/analytics', title: 'Аналитика продаж', desc: 'Выручка, товары и клиенты', icon: 'TrendCharts' }),
      ],
    },
    {
      key: 'refs', title: 'Справочники', icon: 'Notebook', desc: 'Товары, контрагенты, склады и план счетов.',
      items: [
        ...when(c.showTrade, { path: '/catalog/items', title: 'Номенклатура', desc: 'Товары и услуги', icon: 'Goods' }),
        ...when(c.showTrade, { path: '/catalog/counterparties', title: 'Контрагенты', desc: 'Покупатели и поставщики', icon: 'User' }),
        ...when(c.showTrade, { path: '/crm/contracts', title: 'Договоры', desc: 'Все договоры: сроки, отсрочка, документы', icon: 'Document' }),
        ...when(c.showTrade, { path: '/crm/bonus', title: 'Бонусная программа', desc: 'Баллы покупателям за покупки', icon: 'Present' }),
        ...when(c.showTrade, { path: '/catalog/warehouses', title: 'Склады', desc: 'Склады и магазины', icon: 'House' }),
        ...when(c.showAcc, { path: '/accounting/chart', title: 'План счетов', desc: 'Счета бухгалтерского учёта', icon: 'List' }),
        ...when(c.showAcc, { path: '/accounting/refs', title: 'Справочники учёта', desc: 'Банковские счета, статьи, подразделения', icon: 'Collection' }),
      ],
    },
    {
      key: 'admin', title: 'Администрирование', icon: 'Setting', desc: 'Настройки компании, пользователи и ИИ-помощник.',
      items: [
        ...when(c.showAcc, { path: '/accounting/settings', title: 'Учётная политика и периоды', desc: 'Налоговый режим, НДС, закрытые периоды', icon: 'Tools' }),
        { path: '/settings/print', title: 'Печатные формы', desc: 'Вид счетов, накладных и актов', icon: 'Printer' },
        { path: '/settings/users', title: 'Пользователи', desc: 'Сотрудники с доступом и их роли', icon: 'Avatar' },
        ...when(c.can('acc.doc.read'), { path: '/settings/automation', title: 'Сценарии', desc: 'Автоматика: событие документа → задача или этап заказа', icon: 'MagicStick' }),
        ...when(c.can('acc.doc.read'), { path: '/settings/trash', title: 'Корзина', desc: 'Удалённые документы — открыть и восстановить', icon: 'Delete' }),
        ...when(c.can('acc.audit.read'), { path: '/settings/audit', title: 'Журнал действий', desc: 'Кто, что и когда сделал', icon: 'Document' }),
        { path: '/settings/ai', title: 'ИИ-помощник (Claude)', desc: 'Свой адрес коннектора компании и подключения', icon: 'ChatDotRound' },
      ],
    },
  ]
  return sections.filter((s) => s.items.length)
}
