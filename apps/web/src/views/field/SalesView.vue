<template>
  <!-- «Супервайзер»: продажи торговых — заказы из агента за период, сравнение с прошлым периодом, разрезы. -->
  <div class="sales">
    <div class="page-header bar">
      <div>
        <h1>Продажи торговых</h1>
        <div class="sub">Заказы, оформленные торговыми в агенте. Сравнение — с {{ fmtDate(r?.previous.from) }}–{{ fmtDate(r?.previous.to) }}.</div>
      </div>
      <div class="tools">
        <el-radio-group v-model="preset" size="default" @change="applyPreset">
          <el-radio-button v-for="p in PRESETS" :key="p.key" :value="p.key">{{ p.label }}</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" range-separator="—" :clearable="false" style="width: 250px;" @change="preset = ''; load()" />
        <el-select v-model="repId" clearable filterable placeholder="Все торговые" style="width: 200px;" @change="load">
          <el-option v-for="x in reps" :key="x.id" :value="x.id" :label="x.name" />
        </el-select>
        <el-button :icon="Download" :disabled="!r" @click="exportCsv">Скачать</el-button>
      </div>
    </div>

    <div v-loading="loading" class="content">
      <div class="kpis">
        <div v-for="k in kpis" :key="k.key" class="kpi" :class="{ accent: k.key === 'sum' }">
          <div class="k-label">{{ k.label }}</div>
          <div class="k-value">{{ k.value }}</div>
          <div class="k-hint">
            <span v-if="k.delta != null" :class="k.delta > 0 ? 'up' : k.delta < 0 ? 'down' : ''">{{ k.delta > 0 ? '▲' : k.delta < 0 ? '▼' : '' }} {{ Math.abs(k.delta) }}%</span>
            <span v-else-if="k.prev !== undefined" class="muted">новое</span>
            <span class="muted k-was">{{ k.hint }}</span>
          </div>
        </div>
      </div>

      <el-alert v-if="r && !r.totals.count" type="info" :closable="false" show-icon class="gap"
        title="За период заказов из агента нет"
        description="Заказы появляются здесь, когда торговый оформляет их в агенте FlowPOS с привязанным телефоном." />

      <div class="charts">
        <el-card shadow="never" class="chart wide">
          <template #header><b>По дням</b> <span class="muted">сумма заказов и их количество</span></template>
          <v-chart :theme="isDark ? 'fp-dark' : undefined" :key="isDark ? 'd' : 'l'" :option="dayOption" autoresize style="height: 280px;" />
        </el-card>
        <el-card shadow="never" class="chart">
          <template #header><b>Торговые</b> <span class="muted">сумма за период</span></template>
          <v-chart :theme="isDark ? 'fp-dark' : undefined" :key="isDark ? 'd' : 'l'" :option="repOption" autoresize :style="{ height: Math.max(220, (r?.byRep.length ?? 0) * 34 + 40) + 'px' }" @click="onRepChartClick" />
        </el-card>
        <el-card shadow="never" class="chart">
          <template #header><b>Когда заказывают</b> <span class="muted">по часам и дням недели</span></template>
          <v-chart :theme="isDark ? 'fp-dark' : undefined" :key="isDark ? 'd' : 'l'" :option="timeOption" autoresize style="height: 260px;" />
        </el-card>
      </div>

      <el-card shadow="never">
        <el-tabs v-model="tab">
          <el-tab-pane name="reps" :label="`Торговые (${r?.byRep.length ?? 0})`">
            <el-table :data="r?.byRep ?? []" size="small" stripe empty-text="Нет данных" show-summary :summary-method="repSummary" @row-click="(row: any) => pickRep(row.repId)" row-class-name="clickable">
              <el-table-column label="Торговый" min-width="170">
                <template #default="{ row }"><span class="avatar" :style="{ background: repColorOf(row.repId) }">{{ initials(row.name) }}</span> {{ row.name }}</template>
              </el-table-column>
              <el-table-column label="Сумма" min-width="125" align="right" sortable :sort-method="(a: any, b: any) => a.sum - b.sum"><template #default="{ row }"><b>{{ fmtSum(row.sum) }}</b></template></el-table-column>
              <el-table-column label="Доля" min-width="120">
                <template #default="{ row }"><el-progress :percentage="Math.round(row.share)" :stroke-width="8" /></template>
              </el-table-column>
              <el-table-column label="Заказов" prop="count" min-width="85" align="right" sortable />
              <el-table-column label="Средний" min-width="105" align="right"><template #default="{ row }">{{ fmtSum(row.avg) }}</template></el-table-column>
              <el-table-column label="Клиентов" prop="points" min-width="90" align="right" sortable />
              <el-table-column label="На точке / удал." min-width="120" align="right">
                <template #default="{ row }"><span class="ok">{{ row.onSite }}</span> / <span :class="{ warn: row.remote }">{{ row.remote }}</span></template>
              </el-table-column>
              <el-table-column label="Прошлый период" min-width="125" align="right"><template #default="{ row }">{{ fmtSum(row.prevSum) }}</template></el-table-column>
              <el-table-column label="Изменение" min-width="100" align="right"><template #default="{ row }"><Delta :cur="row.sum" :prev="row.prevSum" /></template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane name="points" :label="`Клиенты (${r?.byPoint.length ?? 0})`">
            <el-input v-model="pq" placeholder="Поиск клиента" clearable size="small" style="width: 260px; margin-bottom: 10px;" />
            <el-table :data="pointsShown" size="small" stripe empty-text="Нет заказов" max-height="520">
              <el-table-column type="index" label="№" width="50" />
              <el-table-column label="Клиент" min-width="220">
                <template #default="{ row }"><div>{{ row.name }}</div><div v-if="row.address" class="muted">{{ row.address }}</div></template>
              </el-table-column>
              <el-table-column label="Сумма" width="140" align="right" sortable :sort-method="(a: any, b: any) => a.sum - b.sum"><template #default="{ row }"><b>{{ fmtSum(row.sum) }}</b></template></el-table-column>
              <el-table-column label="Заказов" prop="count" width="90" align="right" sortable />
              <el-table-column label="Средний" width="120" align="right"><template #default="{ row }">{{ fmtSum(row.avg) }}</template></el-table-column>
              <el-table-column label="Последний заказ" width="130"><template #default="{ row }">{{ kzDateTime(row.lastAt) }}</template></el-table-column>
              <el-table-column label="Торговые" min-width="150"><template #default="{ row }">{{ row.reps.join(', ') }}</template></el-table-column>
              <el-table-column label="Изменение" width="110" align="right"><template #default="{ row }"><Delta :cur="row.sum" :prev="row.prevSum" /></template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane name="silent" :label="`Без заказов (${r?.silent.length ?? 0})`">
            <p class="muted gap-sm">Активные точки, которые за период ничего не заказали. Сверху — кто заказывал раньше и пропал: им стоит позвонить или включить в маршрут.</p>
            <el-table :data="r?.silent ?? []" size="small" stripe empty-text="Все точки заказывали" max-height="520">
              <el-table-column label="Клиент" min-width="220">
                <template #default="{ row }"><div>{{ row.name }}</div><div v-if="row.address" class="muted">{{ row.address }}</div></template>
              </el-table-column>
              <el-table-column label="Последний заказ" width="150"><template #default="{ row }">{{ row.lastAt ? kzDateTime(row.lastAt) : 'не заказывал' }}</template></el-table-column>
              <el-table-column label="Сколько дней" width="120" align="right">
                <template #default="{ row }"><span v-if="row.lastAt" :class="{ bad: daysSince(row.lastAt) > 30 }">{{ daysSince(row.lastAt) }}</span><span v-else class="muted">—</span></template>
              </el-table-column>
              <el-table-column label="В прошлом периоде" width="160" align="right"><template #default="{ row }">{{ row.prevSum ? fmtSum(row.prevSum) : '—' }}</template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane name="days" label="По дням">
            <el-table :data="daysDesc" size="small" stripe max-height="520">
              <el-table-column label="Дата" width="140"><template #default="{ row }">{{ fmtDate(row.date) }} <span class="muted">{{ WEEKDAYS[weekday(row.date)] }}</span></template></el-table-column>
              <el-table-column label="Заказов" prop="count" width="100" align="right" />
              <el-table-column label="Сумма" width="160" align="right"><template #default="{ row }">{{ fmtSum(row.sum) }}</template></el-table-column>
              <el-table-column label="Средний" width="140" align="right"><template #default="{ row }">{{ row.count ? fmtSum(row.sum / row.count) : '—' }}</template></el-table-column>
              <el-table-column min-width="200">
                <template #default="{ row }"><div class="bar-cell"><div :style="{ width: barWidth(row.sum) }" /></div></template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTheme } from '@/composables/useTheme'
const { isDark } = useTheme()
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Download } from '@element-plus/icons-vue'
import { use } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { deltaPct, fmtDate, fmtSum, initials, kzDateTime, kzShift, kzToday, loadReps, repColor, type Rep } from './field'

use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

/** Стрелка изменения к прошлому периоду. */
const Delta = defineComponent({
  props: { cur: { type: Number, required: true }, prev: { type: Number, required: true } },
  setup(p) {
    return () => {
      const d = deltaPct(p.cur, p.prev)
      if (d == null) return h('span', { class: 'muted' }, 'новое')
      if (d === 0) return h('span', { class: 'muted' }, '0%')
      return h('span', { class: d > 0 ? 'up' : 'down' }, `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`)
    }
  },
})

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const today = kzToday()
const monthStart = (d: string) => `${d.slice(0, 8)}01`
const PRESETS = [
  { key: 'today', label: 'Сегодня', range: () => [today, today] },
  { key: 'yesterday', label: 'Вчера', range: () => [kzShift(today, -1), kzShift(today, -1)] },
  { key: '7', label: '7 дней', range: () => [kzShift(today, -6), today] },
  { key: 'month', label: 'Месяц', range: () => [monthStart(today), today] },
  { key: 'prevMonth', label: 'Прошлый месяц', range: () => { const end = kzShift(monthStart(today), -1); return [monthStart(end), end] } },
  { key: '90', label: '90 дней', range: () => [kzShift(today, -89), today] },
] as const

const route = useRoute()
const preset = ref<string>('month')
const range = ref<[string, string]>(PRESETS[3].range() as [string, string])
const repId = ref(String(route.query.repId || ''))
const reps = ref<Rep[]>([])
const r = ref<any>(null)
const loading = ref(false)
const tab = ref('reps')
const pq = ref('')

function applyPreset() {
  const p = PRESETS.find((x) => x.key === preset.value)
  if (p) { range.value = p.range() as [string, string]; load() }
}

async function load() {
  loading.value = true
  try {
    r.value = await api.get('/field/sales', { params: { from: range.value[0], to: range.value[1], ...(repId.value ? { repId: repId.value } : {}) } })
  } catch (e) { showError(e) }
  loading.value = false
}

function pickRep(id: string) { if (repId.value !== id) { repId.value = id; load() } }
function onRepChartClick(p: any) { const row = r.value?.byRep?.[r.value.byRep.length - 1 - p.dataIndex]; if (row) pickRep(row.repId) }
const repIndex = computed(() => new Map(reps.value.map((x, i) => [x.id, i])))
const repColorOf = (id: string) => repColor(repIndex.value.get(id) ?? 0)

const kpis = computed(() => {
  const t = r.value?.totals
  const p = r.value?.prevTotals
  if (!t) return []
  const onSitePct = t.count ? Math.round((t.onSite / t.count) * 100) : 0
  return [
    { key: 'sum', label: 'Сумма заказов', value: fmtSum(t.sum), delta: deltaPct(t.sum, p.sum), prev: p.sum, hint: `было ${fmtSum(p.sum)}` },
    { key: 'count', label: 'Заказов', value: String(t.count), delta: deltaPct(t.count, p.count), prev: p.count, hint: `было ${p.count}` },
    { key: 'avg', label: 'Средний заказ', value: fmtSum(t.avg), delta: deltaPct(t.avg, p.avg), prev: p.avg, hint: `было ${fmtSum(p.avg)}` },
    { key: 'points', label: 'Клиентов с заказом', value: String(t.points), delta: deltaPct(t.points, p.points), prev: p.points, hint: `было ${p.points}` },
    { key: 'onsite', label: 'Оформлено на точке', value: `${onSitePct}%`, delta: null, prev: undefined, hint: t.remote ? `удалённо: ${t.remote}` : 'удалённых нет' },
  ]
})

const money = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} млн` : v >= 1e3 ? `${Math.round(v / 1e3)} тыс` : String(Math.round(v)))
const dayOption = computed(() => {
  const days = r.value?.byDay ?? []
  return {
    tooltip: { trigger: 'axis', valueFormatter: undefined, formatter: (ps: any[]) => `${ps[0].axisValue}<br>${ps.map((x) => `${x.marker}${x.seriesName}: ${x.seriesIndex === 0 ? fmtSum(x.value) : x.value}`).join('<br>')}` },
    legend: { data: ['Сумма', 'Заказов'], right: 0, top: 0 },
    grid: { left: 60, right: 40, top: 36, bottom: 30 },
    xAxis: { type: 'category', data: days.map((d: any) => `${d.date.slice(8, 10)}.${d.date.slice(5, 7)}`), axisTick: { show: false } },
    yAxis: [
      { type: 'value', axisLabel: { formatter: money }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
      { type: 'value', minInterval: 1, splitLine: { show: false } },
    ],
    series: [
      { name: 'Сумма', type: 'bar', data: days.map((d: any) => d.sum), itemStyle: { color: '#0f766e', borderRadius: [4, 4, 0, 0] }, barMaxWidth: 28 },
      { name: 'Заказов', type: 'line', yAxisIndex: 1, data: days.map((d: any) => d.count), smooth: true, symbolSize: 6, itemStyle: { color: '#2563eb' } },
    ],
  }
})

const repOption = computed(() => {
  const rows = [...(r.value?.byRep ?? [])].reverse()
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: any[]) => { const x = rows[ps[0].dataIndex]; return `${x.name}<br>${fmtSum(x.sum)} · ${x.count} заказ.` } },
    grid: { left: 10, right: 70, top: 10, bottom: 10, containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: { type: 'category', data: rows.map((x: any) => x.name), axisTick: { show: false }, axisLine: { show: false } },
    series: [{
      type: 'bar', barMaxWidth: 20, cursor: 'pointer',
      data: rows.map((x: any) => ({ value: x.sum, itemStyle: { color: repColorOf(x.repId), borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: 'right', formatter: (p: any) => money(p.value) },
    }],
  }
})

const timeOption = computed(() => {
  const hours = r.value?.byHour ?? []
  const wd = r.value?.byWeekday ?? []
  const fromH = 6, toH = 23
  const hs = hours.filter((x: any) => x.hour >= fromH && x.hour <= toH)
  return {
    tooltip: { trigger: 'axis', formatter: (ps: any[]) => `${ps[0].axisValue}<br>${ps[0].value} заказ.` },
    grid: [{ left: 36, right: 10, top: 10, height: 95 }, { left: 36, right: 10, top: 150, height: 80 }],
    xAxis: [
      { gridIndex: 0, type: 'category', data: hs.map((x: any) => `${x.hour}:00`), axisTick: { show: false }, axisLabel: { interval: 2 } },
      { gridIndex: 1, type: 'category', data: WEEKDAYS, axisTick: { show: false } },
    ],
    yAxis: [
      { gridIndex: 0, type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#f1f5f9' } } },
      { gridIndex: 1, type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    ],
    series: [
      { type: 'bar', xAxisIndex: 0, yAxisIndex: 0, data: hs.map((x: any) => x.count), itemStyle: { color: '#2563eb', borderRadius: [3, 3, 0, 0] } },
      { type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: wd.map((x: any) => x.count), itemStyle: { color: '#0f766e', borderRadius: [3, 3, 0, 0] } },
    ],
  }
})

const pointsShown = computed(() => {
  const s = pq.value.trim().toLowerCase()
  const list = r.value?.byPoint ?? []
  return s ? list.filter((p: any) => `${p.name} ${p.address ?? ''}`.toLowerCase().includes(s)) : list
})
const daysDesc = computed(() => [...(r.value?.byDay ?? [])].reverse())
const maxDay = computed(() => Math.max(1, ...(r.value?.byDay ?? []).map((d: any) => d.sum)))
const barWidth = (v: number) => `${Math.round((v / maxDay.value) * 100)}%`
const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7
const daysSince = (at: string) => Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 86400000))

function repSummary({ columns }: any) {
  const t = r.value?.totals
  const p = r.value?.prevTotals
  return columns.map((_: any, i: number) => {
    if (!t) return ''
    return ['Итого', fmtSum(t.sum), '', String(t.count), fmtSum(t.avg), String(t.points), `${t.onSite} / ${t.remote}`, fmtSum(p.sum), ''][i] ?? ''
  })
}

/** CSV открывается в Excel: разделитель «;», BOM для кириллицы. */
function exportCsv() {
  if (!r.value) return
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const num = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',')
  let rows: unknown[][] = []
  let name = 'торговые'
  if (tab.value === 'reps') rows = [['Торговый', 'Сумма', 'Доля %', 'Заказов', 'Средний', 'Клиентов', 'На точке', 'Удалённо', 'Прошлый период'], ...r.value.byRep.map((x: any) => [x.name, num(x.sum), num(x.share), x.count, num(x.avg), x.points, x.onSite, x.remote, num(x.prevSum)])]
  else if (tab.value === 'points') { name = 'клиенты'; rows = [['Клиент', 'Адрес', 'Сумма', 'Заказов', 'Средний', 'Последний заказ', 'Торговые', 'Прошлый период'], ...r.value.byPoint.map((x: any) => [x.name, x.address, num(x.sum), x.count, num(x.avg), kzDateTime(x.lastAt), x.reps.join(', '), num(x.prevSum)])] }
  else if (tab.value === 'silent') { name = 'без-заказов'; rows = [['Клиент', 'Адрес', 'Последний заказ', 'В прошлом периоде'], ...r.value.silent.map((x: any) => [x.name, x.address, x.lastAt ? kzDateTime(x.lastAt) : 'не заказывал', num(x.prevSum)])] }
  else { name = 'по-дням'; rows = [['Дата', 'Заказов', 'Сумма'], ...r.value.byDay.map((x: any) => [fmtDate(x.date), x.count, num(x.sum)])] }
  const csv = '﻿' + rows.map((row) => row.map(cell).join(';')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = `продажи-${name}-${range.value[0]}_${range.value[1]}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

onMounted(async () => {
  try { reps.value = await loadReps() } catch (e) { showError(e) }
  await load()
})
</script>

<style scoped>
.sales { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 0; }
.bar h1 { margin: 0; }
.sub { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; }
.tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.content { display: flex; flex-direction: column; gap: 14px; }

.kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.kpi { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
.kpi.accent { background: linear-gradient(135deg, #0f766e, #2563eb); color: #fff; border: none; }
.kpi.accent .k-label, .kpi.accent .muted { color: rgba(255, 255, 255, .85); }
.kpi.accent .up, .kpi.accent .down { color: #fff; font-weight: 700; }
.k-label { font-size: 12px; color: var(--el-text-color-secondary); }
.k-value { font-size: 22px; font-weight: 700; line-height: 1.2; }
.k-hint { font-size: 12px; display: flex; gap: 6px; flex-wrap: wrap; }

.charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.chart.wide { grid-column: span 2; }
.chart :deep(.el-card__header) { padding: 10px 16px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.gap { margin: 0; }
.gap-sm { margin: 0 0 10px; }
.up { color: #16a34a; font-weight: 600; }
.down { color: #dc2626; font-weight: 600; }
.ok { color: #16a34a; } .warn { color: #d97706; font-weight: 600; } .bad { color: #dc2626; font-weight: 600; }
.avatar { display: inline-flex; width: 24px; height: 24px; border-radius: 50%; color: #fff; font-size: 10px; font-weight: 700; align-items: center; justify-content: center; margin-right: 6px; vertical-align: middle; }
:deep(.clickable) { cursor: pointer; }
.bar-cell { background: #f1f5f9; border-radius: 4px; height: 10px; overflow: hidden; }
.bar-cell div { background: linear-gradient(90deg, #0f766e, #2563eb); height: 100%; border-radius: 4px; }

@media (max-width: 1200px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 900px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .charts { grid-template-columns: 1fr; }
  .chart.wide { grid-column: auto; }
}
</style>
