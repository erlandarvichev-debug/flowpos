<template>
  <!-- «Пульс бизнеса» (как в УНФ): главные показатели фирмы за период со сравнением с прошлым и мини-графиками. -->
  <el-card v-if="!hidden" shadow="never" class="pulse">
    <template #header>
      <div class="p-head">
        <b><el-icon class="p-hic"><Odometer /></el-icon>Пульс бизнеса</b>
        <span v-if="data" class="muted small">сравнение с {{ fmtD(data.period.prevFrom) }} – {{ fmtD(data.period.prevTo) }}</span>
      </div>
    </template>
    <div v-loading="loading && !data" class="grid">
      <div v-for="t in tiles" :key="t.key" class="tile" :style="{ '--c': t.color }" @click="t.to && router.push(t.to)">
        <div class="t-top">
          <span class="t-ic"><el-icon><component :is="t.icon" /></el-icon></span>
          <span class="t-label">{{ t.label }}</span>
          <span v-if="t.delta !== undefined && t.delta !== null" class="t-delta" :class="t.neutral ? 'muted' : good(t.delta, t.inverse) ? 'up' : 'down'">{{ t.delta > 0 ? '▲' : t.delta < 0 ? '▼' : '' }} {{ Math.abs(t.delta) }}%</span>
        </div>
        <div class="t-val" :class="t.valClass">{{ t.value }}</div>
        <div class="t-sub">
          <span v-for="(s, i) in t.sub" :key="i" :class="s.cls">{{ s.text }}</span>
        </div>
        <v-chart v-if="t.spark" class="spark" :option="t.spark" :theme="isDark ? 'fp-dark' : undefined" :key="isDark ? 'd' : 'l'" autoresize />
      </div>
    </div>
    <div class="hint">По данным учёта: выручка без НДС, прибыль после себестоимости. «Чистая прибыль» — оценка: валовая прибыль минус расходы, записанные в учёте.</div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { use } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import { Odometer } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useTheme } from '@/composables/useTheme'

use([BarChart, LineChart, GridComponent, CanvasRenderer])
const props = defineProps<{ from: string; to: string }>()
const router = useRouter()
const { isDark } = useTheme()
const data = ref<any>(null)
const loading = ref(false)
const hidden = ref(false)

const money = (v: any) => `${Math.round(Number(v || 0)).toLocaleString('ru-RU')} ₸`
const short = (v: any) => { const n = Number(v || 0), a = Math.abs(n); return a >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} млн ₸` : money(n) }
const fmtD = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`
const good = (d: number, inverse?: boolean) => (inverse ? d <= 0 : d >= 0)

function spark(values: number[], color: string, kind: 'line' | 'bar') {
  return {
    animation: false, grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i), boundaryGap: kind === 'bar' },
    yAxis: { type: 'value', show: false, scale: kind === 'line' },
    series: [kind === 'line'
      ? { type: 'line', data: values, smooth: true, symbol: 'none', lineStyle: { width: 2, color }, areaStyle: { color, opacity: 0.12 } }
      : { type: 'bar', data: values, itemStyle: { color, borderRadius: [2, 2, 0, 0] }, barMaxWidth: 8 }],
  }
}

const tiles = computed(() => {
  const d = data.value
  if (!d) return []
  const moneySeries = d.series.map((x: any) => Number(x.money))
  const revSeries = d.series.map((x: any) => Number(x.revenue))
  return [
    { key: 'money', label: 'Деньги на счетах и в кассах', icon: 'Wallet', color: '#23a047', to: '/reports/money-flow', value: short(d.money.end),
      sub: [{ text: `+${short(d.money.inflow)}`, cls: 'ok' }, { text: `−${short(d.money.outflow)}`, cls: 'bad' }], spark: spark(moneySeries, '#23a047', 'line') },
    { key: 'revenue', label: 'Выручка', icon: 'Money', color: '#1769e0', to: '/reports/profitability', value: short(d.revenue.value), delta: d.revenue.delta,
      sub: [{ text: `было ${short(d.revenue.prev)}` }], spark: spark(revSeries, '#1769e0', 'bar') },
    { key: 'gross', label: 'Валовая прибыль', icon: 'TrendCharts', color: '#0f766e', to: '/reports/profitability', value: short(d.grossProfit.value), delta: d.grossProfit.delta,
      valClass: Number(d.grossProfit.value) < 0 ? 'bad' : '', sub: [{ text: d.grossProfit.margin === null ? 'маржа —' : `маржа ${d.grossProfit.margin}%` }, { text: d.grossProfit.prevMargin === null ? '' : `была ${d.grossProfit.prevMargin}%` }] },
    { key: 'net', label: 'Чистая прибыль (оценка)', icon: 'Trophy', color: '#7c3aed', value: short(d.netProfit.value), delta: d.netProfit.delta,
      valClass: Number(d.netProfit.value) < 0 ? 'bad' : '', sub: [{ text: `было ${short(d.netProfit.prev)}` }] },
    { key: 'exp', label: 'Расходы', icon: 'Coin', color: '#dc2626', to: '/accounting/reports/trial-balance', value: short(d.expenses.value), delta: d.expenses.delta, inverse: true,
      sub: d.expenses.top.length ? d.expenses.top.slice(0, 2).map((e: any) => ({ text: `${e.name}: ${short(e.amount)}` })) : [{ text: 'расходов в учёте нет' }] },
    { key: 'stock', label: 'Товарные запасы', icon: 'Box', color: '#0891b2', to: '/reports/stock-turnover', value: short(d.stock.value), delta: d.stock.delta, neutral: true,
      sub: [{ text: `на начало ${short(d.stock.start)}` }] },
    { key: 'recv', label: 'Нам должны покупатели', icon: 'User', color: '#ea580c', to: '/reports/debt-aging', value: short(d.receivable.total),
      sub: [{ text: Number(d.receivable.overdue) ? `просрочено ${short(d.receivable.overdue)}` : 'просрочки нет', cls: Number(d.receivable.overdue) ? 'bad' : 'ok' }, { text: `${d.receivable.count} клиентов` }] },
    { key: 'pay', label: 'Мы должны поставщикам', icon: 'ShoppingCart', color: '#64748b', to: '/reports/debt-aging?side=suppliers', value: short(d.payable.total),
      sub: [{ text: Number(d.payable.overdue) ? `просрочено ${short(d.payable.overdue)}` : 'просрочки нет', cls: Number(d.payable.overdue) ? 'bad' : 'ok' }, { text: `${d.payable.count} поставщиков` }] },
  ] as any[]
})

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  try {
    const r = await api.get('/accounting/reports/pulse', { params: { from: props.from, to: props.to } })
    if (my === seq) data.value = r
  } catch (e: any) {
    if (e?.statusCode === 403 || e?.code === 'FORBIDDEN' || e?.status === 403) hidden.value = true
  } finally { if (my === seq) loading.value = false }
}
watch(() => [props.from, props.to], load, { immediate: true })
</script>

<style scoped>
.pulse { margin-bottom: 16px; }
.p-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.p-hic { vertical-align: -2px; margin-right: 6px; color: var(--el-color-primary); }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; min-height: 120px; }
.tile { position: relative; border: 1px solid var(--fp-border); border-radius: 12px; padding: 12px 14px 8px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; background: var(--fp-surface); transition: border-color .15s, box-shadow .15s, transform .15s; overflow: hidden; }
.tile:hover { border-color: color-mix(in srgb, var(--c) 45%, transparent); box-shadow: var(--fp-shadow-lg); transform: translateY(-1px); }
.tile::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--c); }
.t-top { display: flex; align-items: center; gap: 8px; }
.t-ic { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); font-size: 15px; flex: none; }
.t-label { font-size: 12.5px; color: var(--fp-text-2); font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-delta { font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.t-val { font-size: 21px; font-weight: 700; letter-spacing: -.01em; margin-top: 6px; font-variant-numeric: tabular-nums; }
.t-sub { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 12px; color: var(--fp-text-3); min-height: 17px; }
.spark { height: 40px; margin-top: 4px; }
.up, .ok { color: var(--el-color-success); }
.down, .bad { color: var(--el-color-danger); }
.muted { color: var(--fp-text-3); }
.small { font-size: 12px; }
.hint { color: var(--fp-text-3); font-size: 12px; margin-top: 10px; }
@media (max-width: 1200px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
</style>
