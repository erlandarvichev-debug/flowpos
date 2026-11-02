import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/auth/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('@/components/layout/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', redirect: '/dashboard' },
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@/views/DashboardView.vue'),
          meta: { title: 'Дашборд', icon: 'Odometer' },
        },
        // Каталог
        {
          path: 'catalog/items',
          name: 'items',
          component: () => import('@/views/catalog/ItemsView.vue'),
          meta: { title: 'Номенклатура', icon: 'Box' },
        },
        {
          path: 'catalog/items/:id',
          name: 'item-detail',
          component: () => import('@/views/catalog/ItemDetailView.vue'),
        },
        {
          path: 'catalog/warehouses',
          name: 'warehouses',
          component: () => import('@/views/catalog/WarehousesView.vue'),
          meta: { title: 'Склады', icon: 'House' },
        },
        {
          path: 'catalog/counterparties',
          name: 'counterparties',
          component: () => import('@/views/catalog/CounterpartiesView.vue'),
          meta: { title: 'Контрагенты', icon: 'User' },
        },
        {
          path: 'catalog/pricing',
          name: 'pricing',
          component: () => import('@/views/catalog/PricingView.vue'),
          meta: { title: 'Цены и скидки', icon: 'PriceTag' },
        },
        {
          path: 'catalog/counterparties/:id',
          name: 'counterparty-detail',
          component: () => import('@/views/catalog/CounterpartyDetailView.vue'),
        },
        // Закупки
        {
          path: 'trade/purchases',
          name: 'purchases',
          component: () => import('@/views/trade/PurchasesView.vue'),
          meta: { title: 'Закупки', icon: 'Download' },
        },
        // Продажи
        {
          path: 'trade/sales',
          name: 'sales',
          component: () => import('@/views/trade/SalesView.vue'),
          meta: { title: 'Продажи', icon: 'Upload' },
        },
        // Склад
        {
          path: 'trade/stocks',
          name: 'stocks',
          component: () => import('@/views/trade/StocksView.vue'),
          meta: { title: 'Остатки', icon: 'DataBoard' },
        },
        {
          path: 'trade/transfers',
          name: 'transfers',
          component: () => import('@/views/trade/TransfersView.vue'),
          meta: { title: 'Перемещения', icon: 'Refresh' },
        },
        {
          path: 'trade/inventories',
          name: 'inventories',
          component: () => import('@/views/trade/InventoriesView.vue'),
          meta: { title: 'Инвентаризации', icon: 'List' },
        },
        // POS
        {
          path: 'pos/terminals',
          name: 'terminals',
          component: () => import('@/views/pos/TerminalsView.vue'),
          meta: { title: 'Кассы', icon: 'Monitor' },
        },
        {
          path: 'pos/shifts',
          name: 'shifts',
          component: () => import('@/views/pos/ShiftsView.vue'),
          meta: { title: 'Смены', icon: 'Clock' },
        },
        {
          path: 'pos/receipts',
          name: 'receipts',
          component: () => import('@/views/pos/ReceiptsView.vue'),
          meta: { title: 'Чеки', icon: 'Ticket' },
        },
        // HR
        {
          path: 'hr/employees',
          name: 'employees',
          component: () => import('@/views/hr/EmployeesView.vue'),
          meta: { title: 'Сотрудники', icon: 'UserFilled' },
        },
        {
          path: 'hr/schedule',
          name: 'schedule',
          component: () => import('@/views/hr/ScheduleView.vue'),
          meta: { title: 'График смен', icon: 'Calendar' },
        },
        {
          path: 'hr/timesheet',
          name: 'timesheet',
          component: () => import('@/views/hr/TimesheetView.vue'),
          meta: { title: 'Табель', icon: 'Document' },
        },
        {
          path: 'hr/payrolls',
          name: 'payrolls',
          component: () => import('@/views/hr/PayrollsView.vue'),
          meta: { title: 'Зарплата', icon: 'Money' },
        },
        // Бухгалтерия
        { path: 'accounting/chart', name: 'acc-chart', component: () => import('@/views/accounting/ChartView.vue'), meta: { title: 'План счетов' } },
        { path: 'accounting/documents', name: 'acc-documents', component: () => import('@/views/accounting/DocumentsView.vue'), meta: { title: 'Документы учёта' } },
        { path: 'accounting/documents/new', name: 'acc-document-new', component: () => import('@/views/accounting/DocumentView.vue'), meta: { title: 'Новый документ' } },
        { path: 'accounting/documents/:id', name: 'acc-document', component: () => import('@/views/accounting/DocumentView.vue'), meta: { title: 'Документ' } },
        { path: 'accounting/reports/trial-balance', name: 'acc-tb', component: () => import('@/views/accounting/TrialBalanceView.vue'), meta: { title: 'ОСВ' } },
        { path: 'accounting/reports/account-card', name: 'acc-card', component: () => import('@/views/accounting/AccountCardView.vue'), meta: { title: 'Карточка счёта' } },
        { path: 'accounting/reports/journal', name: 'acc-journal', component: () => import('@/views/accounting/JournalView.vue'), meta: { title: 'Журнал проводок' } },
        { path: 'accounting/refs', name: 'acc-refs', component: () => import('@/views/accounting/RefsView.vue'), meta: { title: 'Справочники учёта' } },
        { path: 'accounting/settings', name: 'acc-settings', component: () => import('@/views/accounting/SettingsView.vue'), meta: { title: 'Настройки учёта' } },
        { path: 'accounting/periods', redirect: '/accounting/settings' },
        { path: 'accounting/trade', name: 'acc-trade', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Торговые документы' } },
        { path: 'accounting/trade/new', name: 'acc-trade-new', component: () => import('@/views/accounting/TradeDocumentView.vue'), meta: { title: 'Новый торговый документ' } },
        { path: 'accounting/trade/:id', name: 'acc-trade-doc', component: () => import('@/views/accounting/TradeDocumentView.vue'), meta: { title: 'Торговый документ' } },
        { path: 'accounting/bank-import', name: 'acc-bank-import', component: () => import('@/views/accounting/BankImportView.vue'), meta: { title: 'Импорт выписки' } },
        { path: 'accounting/closing', name: 'acc-closing', component: () => import('@/views/accounting/ClosingView.vue'), meta: { title: 'Закрытие месяца' } },
        { path: 'accounting/statements', name: 'acc-statements', component: () => import('@/views/accounting/StatementsView.vue'), meta: { title: 'Финансовая отчётность' } },
        { path: 'accounting/approvals', name: 'acc-approvals', component: () => import('@/views/accounting/ApprovalsView.vue'), meta: { title: 'Согласования' } },
        { path: 'accounting/esf', name: 'acc-esf', component: () => import('@/views/accounting/EsfView.vue'), meta: { title: 'ЭСФ' } },
        { path: 'accounting/autopilot', name: 'acc-autopilot', component: () => import('@/views/accounting/AutopilotView.vue'), meta: { title: 'Автопилот' } },
        { path: 'accounting/purchase-needs', name: 'acc-purchase-needs', component: () => import('@/views/accounting/PurchaseNeedsView.vue'), meta: { title: 'Потребность и закупки' } },
        { path: 'accounting/stock-movements', name: 'acc-stock-movements', component: () => import('@/views/accounting/StockMovementsView.vue'), meta: { title: 'Движения товаров' } },
        { path: 'accounting/reports/stock', name: 'acc-stock', component: () => import('@/views/accounting/StockReportView.vue'), meta: { title: 'Остатки и себестоимость' } },
        { path: 'accounting/reports/settlements', name: 'acc-settlements', component: () => import('@/views/accounting/SettlementsView.vue'), meta: { title: 'Взаиморасчёты' } },
        // Журналы разделов: тот же список документов, только нужные виды (meta.docTypes)
        { path: 'sales/orders', name: 'j-sales-orders', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Заказы покупателей', docTypes: ['CUSTOMER_ORDER'] } },
        { path: 'sales/shipments', name: 'j-sales-shipments', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Реализации', docTypes: ['DEMAND'] } },
        { path: 'sales/returns', name: 'j-sales-returns', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Возвраты от покупателей', docTypes: ['SALES_RETURN'] } },
        { path: 'sales/retail', name: 'j-sales-retail', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Розничные продажи', docTypes: ['RETAIL_DEMAND', 'RETAIL_RETURN'] } },
        { path: 'purchases/orders', name: 'j-purchases-orders', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Заказы поставщикам', docTypes: ['PURCHASE_ORDER'] } },
        { path: 'purchases/receipts', name: 'j-purchases-receipts', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Поступления товаров', docTypes: ['SUPPLY'] } },
        { path: 'purchases/landed-costs', name: 'j-purchases-landed-costs', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Доп. расходы на поступление', docTypes: ['LANDED_COST'] } },
        { path: 'purchases/returns', name: 'j-purchases-returns', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Возвраты поставщикам', docTypes: ['PURCHASE_RETURN'] } },
        { path: 'warehouse/entries', name: 'j-warehouse-entries', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Оприходования и списания', docTypes: ['ENTER', 'LOSS'] } },
        { path: 'warehouse/moves', name: 'j-warehouse-moves', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Перемещения', docTypes: ['MOVE'] } },
        { path: 'warehouse/inventories', name: 'j-warehouse-inventories', component: () => import('@/views/accounting/TradeDocumentsView.vue'), meta: { title: 'Инвентаризации', docTypes: ['INVENTORY'] } },
        { path: 'bank/statements', name: 'j-bank-statements', component: () => import('@/views/accounting/DocumentsView.vue'), meta: { title: 'Банковские выписки', docTypes: ['BANK_IN', 'BANK_OUT'] } },
        { path: 'bank/cash', name: 'j-bank-cash', component: () => import('@/views/accounting/DocumentsView.vue'), meta: { title: 'Кассовые документы', docTypes: ['CASH_IN', 'CASH_OUT'] } },
        { path: 'operations/manual', name: 'j-operations-manual', component: () => import('@/views/accounting/DocumentsView.vue'), meta: { title: 'Операции вручную', docTypes: ['MANUAL_OPERATION', 'OPENING_BALANCE', 'STORNO'] } },
        // Налоги (FP-039)
        { path: 'tax/rules', name: 'tax-rules', component: () => import('@/views/tax/TaxRulesView.vue'), meta: { title: 'Налоговые правила' } },
        { path: 'tax/declarations', name: 'tax-declarations', component: () => import('@/views/tax/DeclarationsView.vue'), meta: { title: 'Декларации' } },
        { path: 'tax/simplified', name: 'tax-simplified', component: () => import('@/views/tax/SimplifiedRegisterView.vue'), meta: { title: 'Доходы для упрощёнки' } },
        { path: 'tax/vat', name: 'tax-vat', component: () => import('@/views/tax/VatRegisterView.vue'), meta: { title: 'Регистр НДС' } },
        // Аналитика
        {
          path: 'analytics',
          name: 'analytics',
          component: () => import('@/views/analytics/AnalyticsView.vue'),
          meta: { title: 'Аналитика', icon: 'TrendCharts' },
        },
        // Настройки
        {
          path: 'settings/users',
          name: 'settings-users',
          component: () => import('@/views/settings/UsersView.vue'),
          meta: { title: 'Пользователи', icon: 'Avatar' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (to.meta.public) return true

  if (!auth.token) return '/login'

  if (!auth.user) {
    await auth.fetchMe()
    if (!auth.user) return '/login'
  }

  return true
})

export default router
