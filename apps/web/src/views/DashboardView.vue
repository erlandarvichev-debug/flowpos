<template>
  <div class="dash">
    <div class="page-header">
      <div class="hello">
        <div class="h-ic"><el-icon :size="24"><HomeFilled /></el-icon></div>
        <div>
        <h1>{{ greeting }}</h1>
        <div class="sub">{{ periodText }}<template v-if="data"> · сравнение с {{ fmtDate(data.period.prevFrom) }}–{{ fmtDate(kzShift(data.period.from, -1)) }}</template></div>
        </div>
      </div>
      <div class="bar">
        <el-radio-group v-model="preset" size="default" @change="applyPreset">
          <el-radio-button value="today">Сегодня</el-radio-button>
          <el-radio-button value="yesterday">Вчера</el-radio-button>
          <el-radio-button value="7d">7 дней</el-radio-button>
          <el-radio-button value="month">Месяц</el-radio-button>
          <el-radio-button value="prevMonth">Прошлый месяц</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="range" type="daterange" range-separator="–" start-placeholder="С" end-placeholder="По" format="DD.MM.YYYY" value-format="YYYY-MM-DD" :clearable="false" style="width: 250px" @change="preset = ''; load()" />
      </div>
    </div>

    <div v-if="actions.length" class="quick">
      <router-link v-for="a in actions" :key="a.path" :to="a.path" class="q" :style="{ '--c': a.color }">
        <span class="q-ic"><el-icon :size="20"><component :is="a.icon" /></el-icon></span>
        <span class="q-t">{{ a.title }}</span>
      </router-link>
    </div>

    <el-result v-if="forbidden" icon="info" title="Добро пожаловать в FlowPOS" sub-title="Показатели продаж доступны руководителю. Нужные вам разделы — в меню слева." />

    <template v-else>
      <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="mb">
        <el-button size="small" @click="load">Повторить</el-button>
      </el-alert>

      <div class="kpis" v-loading="loading && !data">
        <div v-for="(k, i) in kpis" :key="k.label" class="kpi">
          <div class="k-top"><div class="k-label">{{ k.label }}</div><span class="k-ic" :style="{ '--c': KPI_ICONS[i][1] }"><el-icon><component :is="KPI_ICONS[i][0]" /></el-icon></span></div>
          <div class="k-value">{{ k.value }}</div>
          <div class="k-hint">
            <span v-if="k.delta !== undefined" :class="deltaClass(k.delta, k.inverse)">{{ deltaText(k.delta) }}</span>
            <span class="muted">{{ k.hint }}</span>
          </div>
        </div>
      </div>

      <BusinessPulse :from="range[0]" :to="range[1]" />

      <div class="row">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <div class="card-head"><b><el-icon class="ch-ic"><TrendCharts /></el-icon>Продажи по дням</b><span class="muted">оптом и в розницу, ₸</span></div>
          </template>
          <v-chart :theme="isDark ? 'fp-dark' : undefined" :key="isDark ? 'd' : 'l'" v-if="data?.byDay.length" class="chart" :option="chartOption" autoresize />
          <el-empty v-else description="Продаж за период нет" :image-size="70" />
        </el-card>

        <el-card shadow="never" class="side-card">
          <template #header><div class="card-head"><b><el-icon class="ch-ic"><Bell /></el-icon>Требует внимания</b></div></template>
          <div class="att" @click="router.push('/sales/orders')">
            <el-icon class="a-ico blue"><Tickets /></el-icon>
            <div class="a-txt"><div>Заказы покупателей в работе</div><div class="muted">{{ fmtMoney(att.openOrdersSum) }} ₸</div></div>
            <b>{{ att.openOrders }}</b>
          </div>
          <div class="att" @click="router.push({ path: '/trade/stocks', query: { filter: 'below' } })">
            <el-icon class="a-ico orange"><Warning /></el-icon>
            <div class="a-txt"><div>Товары ниже точки заказа</div><div class="muted">пора заказать у поставщика</div></div>
            <b :class="{ warn: att.belowMin }">{{ att.belowMin }}</b>
          </div>
          <div class="att" @click="router.push({ path: '/trade/stocks', query: { filter: 'negative' } })">
            <el-icon class="a-ico red"><RemoveFilled /></el-icon>
            <div class="a-txt"><div>Товары в минусе</div><div class="muted">продано больше, чем оприходовано</div></div>
            <b :class="{ bad: att.negativeStock }">{{ att.negativeStock }}</b>
          </div>
          <div v-if="debts" class="att" @click="router.push('/reports/debt-aging')">
            <el-icon class="a-ico red"><Timer /></el-icon>
            <div class="a-txt"><div>Просроченные долги покупателей</div><div class="muted">{{ debts.lines.filter((l: any) => Number(l.overdue) > 0).length }} клиентов</div></div>
            <b :class="{ bad: Number(debts.totals.overdue) > 0 }">{{ fmtMoney(Number(debts.totals.overdue)) }}</b>
          </div>
          <div class="att" @click="router.push('/pos/shifts')">
            <el-icon class="a-ico green"><Monitor /></el-icon>
            <div class="a-txt"><div>Открытые кассовые смены</div></div>
            <b>{{ att.activeShifts }}</b>
          </div>
        </el-card>
      </div>

      <div class="row two">
        <el-card shadow="never">
          <template #header><div class="card-head"><b><el-icon class="ch-ic"><Finished /></el-icon>Мои задачи</b><router-link to="/tasks" class="more">все задачи →</router-link></div></template>
          <TaskList scope="mine" :limit="6" empty-text="Задач нет — можно поставить себе или коллеге" placeholder="Новая задача: что сделать?" />
        </el-card>
        <el-card shadow="never">
          <template #header><div class="card-head"><b><el-icon class="ch-ic"><Timer /></el-icon>Кто должен больше всего</b><router-link to="/reports/debt-aging" class="more">долги по срокам →</router-link></div></template>
          <div v-if="debts?.lines?.length">
            <div v-for="l in debts.lines.slice(0, 6)" :key="l.counterpartyId" class="debt" @click="router.push(`/catalog/counterparties/${l.counterpartyId}`)">
              <div class="d-name"><div class="ell">{{ l.name }}</div><div class="muted small">{{ l.maxOverdueDays ? `просрочка до ${l.maxOverdueDays} дн.` : 'в срок' }}</div></div>
              <div class="d-sum"><b>{{ fmtMoney(Number(l.total)) }}</b><div v-if="Number(l.overdue)" class="bad small">просрочено {{ fmtMoney(Number(l.overdue)) }}</div></div>
            </div>
          </div>
          <el-empty v-else description="Долгов нет" :image-size="60" />
        </el-card>
      </div>

      <div class="row two">
        <el-card shadow="never">
          <template #header><div class="card-head"><b><el-icon class="ch-ic"><Goods /></el-icon>Лучшие товары</b><span class="muted">по сумме продаж</span></div></template>
          <el-table v-if="data?.topItems.length" :data="data.topItems" size="small" :show-header="false" @row-click="(r: any) => router.push(`/catalog/items/${r.productId}`)" row-class-name="clickable">
            <el-table-column type="index" width="36" />
            <el-table-column min-width="180"><template #default="{ row }"><div class="ell">{{ row.name }}</div><div class="muted small">{{ fmtQty(row.qty) }} шт.</div></template></el-table-column>
            <el-table-column width="130" align="right"><template #default="{ row }"><b>{{ fmtMoney(row.amount) }}</b></template></el-table-column>
            <el-table-column width="90"><template #default="{ row }"><el-progress :percentage="share(row.amount, data!.topItems[0].amount)" :show-text="false" :stroke-width="6" /></template></el-table-column>
          </el-table>
          <el-empty v-else description="Нет продаж" :image-size="60" />
        </el-card>
        <el-card shadow="never">
          <template #header><div class="card-head"><b><el-icon class="ch-ic"><User /></el-icon>Лучшие покупатели</b><span class="muted">оптовые реализации</span></div></template>
          <el-table v-if="data?.topCustomers.length" :data="data.topCustomers" size="small" :show-header="false" @row-click="(r: any) => router.push(`/catalog/counterparties/${r.counterpartyId}`)" row-class-name="clickable">
            <el-table-column type="index" width="36" />
            <el-table-column min-width="180"><template #default="{ row }"><div class="ell">{{ row.name }}</div><div class="muted small">{{ row.docs }} {{ plural(row.docs, 'отгрузка', 'отгрузки', 'отгрузок') }}</div></template></el-table-column>
            <el-table-column width="130" align="right"><template #default="{ row }"><b>{{ fmtMoney(row.amount) }}</b></template></el-table-column>
          </el-table>
          <el-empty v-else description="Нет оптовых продаж" :image-size="60" />
        </el-card>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useTheme } from '@/composables/useTheme'
const { isDark } = useTheme()
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { use } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import { Bell, Finished, Goods, HomeFilled, Monitor, RemoveFilled, Tickets, Timer, TrendCharts, User, Warning } from '@element-plus/icons-vue'
import TaskList from '@/components/tasks/TaskList.vue'
import BusinessPulse from '@/components/dashboard/BusinessPulse.vue'
import { useOrgStore } from '@/stores/org'
import { useAuthStore } from '@/stores/auth'
import { useSolutionsStore } from '@/stores/solutions'
import api from '@/api/client'
import { deltaPct, fmtDate, kzShift, kzToday } from '@/views/field/field'

use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

interface Totals { revenue: number; wholesale: number; retail: number; returns: number; sales: number; avgCheck: number }
interface Dash {
  period: { from: string; to: string; prevFrom: string }
  kpi: Totals; prev: Totals
  byDay: { date: string; wholesale: number; retail: number; returns: number; sales: number }[]
  topItems: { productId: string; name: string; code: string | null; qty: number; amount: number }[]
  topCustomers: { counterpartyId: string; name: string; amount: number; docs: number }[]
  attention: { openOrders: number; openOrdersSum: number; belowMin: number; negativeStock: number; activeShifts: number }
}

const router = useRouter()
const org = useOrgStore()
const auth = useAuthStore()
const solutions = useSolutionsStore()
const KPI_ICONS: [string, string][] = [['Money', '#1769e0'], ['ShoppingBag', '#23a047'], ['Coin', '#7c3aed'], ['RefreshLeft', '#dc2626']]
const greeting = computed(() => {
  const h = new Date().getHours()
  const name = auth.user?.firstName ? `, ${auth.user.firstName}` : ''
  return `${h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'}${name}`
})
/** Быстрые действия главной: самые частые операции, по правам и подпискам. */
const actions = computed(() => {
  const w = org.can('acc.doc.write'), trade = solutions.trade
  const a: { path: string; title: string; icon: string; color: string }[] = []
  if (trade && w) a.push(
    { path: '/accounting/trade/new?type=CUSTOMER_ORDER', title: 'Новый заказ', icon: 'Tickets', color: '#1769e0' },
    { path: '/accounting/trade/new?type=DEMAND', title: 'Реализация', icon: 'Sell', color: '#1769e0' },
    { path: '/accounting/trade/new?type=INVOICE_OUT', title: 'Счёт покупателю', icon: 'Document', color: '#1769e0' },
    { path: '/accounting/trade/new?type=SUPPLY', title: 'Поступление', icon: 'Download', color: '#7c3aed' },
  )
  if (w) a.push({ path: '/accounting/documents/new?type=CASH_IN', title: 'Принять оплату', icon: 'Wallet', color: '#23a047' })
  if (trade) a.push({ path: '/trade/stocks', title: 'Остатки', icon: 'Box', color: '#0891b2' }, { path: '/reports/profitability', title: 'Прибыльность', icon: 'Money', color: '#0f766e' })
  return a
})
const debts = ref<any>(null)
async function loadDebts() { try { debts.value = await api.get('/accounting/reports/debt-aging', { params: { side: 'customers' } }) } catch { debts.value = null } }
const data = ref<Dash | null>(null)
const loading = ref(false)
const error = ref('')
const forbidden = ref(false)
const preset = ref('month')
const range = ref<[string, string]>([kzToday().slice(0, 8) + '01', kzToday()])

const fmtMoney = (v: number) => Math.round(v).toLocaleString('ru-RU')
const fmtQty = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 3 })
const share = (v: number, max: number) => (max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0)
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
}
const deltaText = (d: number | null) => (d === null ? 'новое' : `${d > 0 ? '▲' : d < 0 ? '▼' : ''} ${Math.abs(d)}%`)
const deltaClass = (d: number | null, inverse = false) => (d === null || d === 0 ? 'muted' : (d > 0) !== inverse ? 'up' : 'down')

const periodText = computed(() => (range.value[0] === range.value[1] ? fmtDate(range.value[0]) : `${fmtDate(range.value[0])} – ${fmtDate(range.value[1])}`))
const att = computed(() => data.value?.attention ?? { openOrders: 0, openOrdersSum: 0, belowMin: 0, negativeStock: 0, activeShifts: 0 })

const kpis = computed(() => {
  const k = data.value?.kpi, p = data.value?.prev
  if (!k || !p) return [
    { label: 'Выручка', value: '—', hint: '' }, { label: 'Продаж', value: '—', hint: '' },
    { label: 'Средний чек', value: '—', hint: '' }, { label: 'Возвраты', value: '—', hint: '' },
  ] as any[]
  return [
    { label: 'Выручка, ₸', value: fmtMoney(k.revenue), delta: deltaPct(k.revenue, p.revenue), hint: `опт ${fmtMoney(k.wholesale)} · розница ${fmtMoney(k.retail)}` },
    { label: 'Продаж', value: k.sales.toLocaleString('ru-RU'), delta: deltaPct(k.sales, p.sales), hint: `было ${p.sales.toLocaleString('ru-RU')}` },
    { label: 'Средний чек, ₸', value: fmtMoney(k.avgCheck), delta: deltaPct(k.avgCheck, p.avgCheck), hint: `было ${fmtMoney(p.avgCheck)}` },
    { label: 'Возвраты, ₸', value: fmtMoney(k.returns), delta: deltaPct(k.returns, p.returns), inverse: true, hint: k.wholesale + k.retail ? `${Math.round((k.returns / (k.wholesale + k.retail)) * 1000) / 10}% от продаж` : '' },
  ]
})

const chartOption = computed(() => {
  // все дни периода, даже без продаж — чтобы провалы были видны
  const map = new Map((data.value?.byDay ?? []).map((d) => [d.date, d]))
  const days: string[] = []
  for (let d = range.value[0]; d <= range.value[1] && days.length < 800; d = kzShift(d, 1)) days.push(d)
  const get = (d: string, k: 'wholesale' | 'retail' | 'returns') => map.get(d)?.[k] ?? 0
  return {
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${fmtMoney(v)} ₸` },
    legend: { bottom: 0, data: ['Опт', 'Розница', 'Возвраты'] },
    grid: { left: 8, right: 12, top: 16, bottom: 36, containLabel: true },
    xAxis: { type: 'category', data: days.map((d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => (v >= 1e6 ? `${v / 1e6} млн` : v >= 1e3 ? `${v / 1e3} тыс` : String(v)) } },
    series: [
      { name: 'Опт', type: 'bar', stack: 's', data: days.map((d) => get(d, 'wholesale')), itemStyle: { color: '#3b82f6' }, barMaxWidth: 28 },
      { name: 'Розница', type: 'bar', stack: 's', data: days.map((d) => get(d, 'retail')), itemStyle: { color: '#10b981', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 28 },
      { name: 'Возвраты', type: 'line', data: days.map((d) => get(d, 'returns')), itemStyle: { color: '#ef4444' }, symbolSize: 4, smooth: true },
    ],
  }
})

function applyPreset() {
  const t = kzToday()
  const firstOf = (d: string) => d.slice(0, 8) + '01'
  if (preset.value === 'today') range.value = [t, t]
  else if (preset.value === 'yesterday') { const y = kzShift(t, -1); range.value = [y, y] }
  else if (preset.value === '7d') range.value = [kzShift(t, -6), t]
  else if (preset.value === 'month') range.value = [firstOf(t), t]
  else if (preset.value === 'prevMonth') { const end = kzShift(firstOf(t), -1); range.value = [firstOf(end), end] }
  load()
}

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  error.value = ''
  try {
    const res = (await api.get('/analytics/dashboard', { params: { from: range.value[0], to: range.value[1] } })) as Dash
    if (my === seq) data.value = res
  } catch (e: any) {
    if (my !== seq) return
    if (e?.statusCode === 403 || e?.status === 403 || e?.response?.status === 403) forbidden.value = true
    else error.value = e?.message || 'Не удалось загрузить показатели'
  } finally {
    if (my === seq) loading.value = false
  }
}

onMounted(() => { load(); loadDebts() })
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.page-header h1 { margin: 0; }
.hello { display: flex; align-items: center; gap: 14px; }
.h-ic { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; color: #fff; background: linear-gradient(135deg, #1769e0, #23a047); box-shadow: 0 8px 20px rgba(23, 105, 224, .25); flex: none; }
.quick { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
.q { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--fp-surface); border: 1px solid var(--fp-border); color: var(--fp-text); text-decoration: none; font-weight: 500; font-size: 14px; transition: transform .15s, box-shadow .15s, border-color .15s; }
.q:hover { transform: translateY(-2px); box-shadow: var(--fp-shadow-lg); border-color: color-mix(in srgb, var(--c) 40%, transparent); }
.q-ic { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--c); background: color-mix(in srgb, var(--c) 11%, transparent); flex: none; }
.k-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.k-ic { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--c); background: color-mix(in srgb, var(--c) 11%, transparent); font-size: 18px; flex: none; }
.ch-ic { vertical-align: -2px; margin-right: 6px; color: var(--el-color-primary); }
.more { font-size: 12px; color: var(--el-color-primary); text-decoration: none; }
.debt { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 9px 4px; border-bottom: 1px solid var(--fp-border-soft); cursor: pointer; border-radius: 6px; }
.debt:hover { background: var(--el-fill-color-light); }
.d-name { min-width: 0; flex: 1; }
.d-sum { text-align: right; font-variant-numeric: tabular-nums; }
.bad { color: var(--el-color-danger); }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 4px; }
.bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.mb { margin-bottom: 12px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; min-height: 100px; }
.kpi { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 16px 18px; }
.k-label { font-size: 13px; color: var(--el-text-color-secondary); }
.k-value { font-size: 26px; font-weight: 600; margin: 6px 0 4px; font-variant-numeric: tabular-nums; }
.k-hint { font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.up { color: var(--el-color-success); font-weight: 500; }
.down { color: var(--el-color-danger); font-weight: 500; }
.muted { color: var(--el-text-color-secondary); }
.small { font-size: 12px; }
.row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 16px; margin-bottom: 16px; }
.row.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.card-head .muted { font-size: 12px; }
.chart { height: 300px; }
.att { display: flex; align-items: center; gap: 12px; padding: 10px 6px; border-radius: 8px; cursor: pointer; }
.att:hover { background: var(--el-fill-color-light); }
.att + .att { border-top: 1px solid var(--el-border-color-extra-light); }
.a-ico { font-size: 20px; padding: 7px; border-radius: 8px; box-sizing: content-box; }
.a-ico.blue { color: #3b82f6; background: #3b82f61a; }
.a-ico.orange { color: #f59e0b; background: #f59e0b1a; }
.a-ico.red { color: #ef4444; background: #ef44441a; }
.a-ico.green { color: #10b981; background: #10b9811a; }
.a-txt { flex: 1; font-size: 13px; line-height: 1.35; }
.a-txt .muted { font-size: 12px; }
.att b { font-size: 18px; font-variant-numeric: tabular-nums; }
.att b.warn { color: var(--el-color-warning); }
.att b.bad { color: var(--el-color-danger); }
.ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:deep(.clickable) { cursor: pointer; }
@media (max-width: 1100px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .row, .row.two { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } .kpi { padding: 12px; } .k-value { font-size: 19px; } .k-hint { font-size: 11px; } }
</style>
