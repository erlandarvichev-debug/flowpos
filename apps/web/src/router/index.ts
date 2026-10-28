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
        { path: 'accounting/esf', name: 'acc-esf', component: () => import('@/views/accounting/EsfView.vue'), meta: { title: 'ЭСФ' } },
        { path: 'accounting/autopilot', name: 'acc-autopilot', component: () => import('@/views/accounting/AutopilotView.vue'), meta: { title: 'Автопилот' } },
        { path: 'accounting/reports/stock', name: 'acc-stock', component: () => import('@/views/accounting/StockReportView.vue'), meta: { title: 'Остатки и себестоимость' } },
        { path: 'accounting/reports/settlements', name: 'acc-settlements', component: () => import('@/views/accounting/SettlementsView.vue'), meta: { title: 'Взаиморасчёты' } },
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
        {
          path: 'settings/integration',
          name: 'settings-integration',
          component: () => import('@/views/settings/IntegrationView.vue'),
          meta: { title: 'Интеграция 1С', icon: 'Connection' },
        },
        {
          path: 'settings/conflicts',
          name: 'settings-conflicts',
          component: () => import('@/views/settings/ConflictsView.vue'),
          meta: { title: 'Конфликты синх.', icon: 'Warning' },
        },
        {
          path: 'settings/simulator',
          name: 'settings-simulator',
          component: () => import('@/views/settings/SimulatorView.vue'),
          meta: { title: 'Симулятор (дев)', icon: 'Tools' },
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
