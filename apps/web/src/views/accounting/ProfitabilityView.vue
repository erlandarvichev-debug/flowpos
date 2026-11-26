<template>
  <div>
    <PageHeader title="Прибыльность" subtitle="Выручка без НДС, себестоимость и прибыль по проведённым продажам и возвратам">
      <el-button :icon="Download" :disabled="!rows.length" @click="exportCsv">CSV</el-button>
    </PageHeader>

    <el-card shadow="never">
      <div class="filters">
        <el-radio-group v-model="groupBy" @change="load">
          <el-radio-button v-for="g in GROUPS" :key="g.key" :value="g.key">{{ g.label }}</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" unlink-panels :shortcuts="shortcuts" :clearable="false" style="width: 250px;" @change="load" />
        <el-checkbox v-model="compare" @change="load">Сравнить с прошлым периодом</el-checkbox>
        <el-input v-model="search" placeholder="Поиск" clearable style="width: 200px;" :prefix-icon="Search" />
        <el-checkbox v-model="onlyLoss">Только убыточные</el-checkbox>
      </div>

      <div v-if="data" class="kpis">
        <div class="kpi"><span class="kpi-ic" style="--c: #1769e0"><el-icon><component is="Money" /></el-icon></span><div class="k-label">Выручка (за вычетом возвратов)</div><div class="k-val">{{ fmtTenge(data.totals.netRevenue) }}</div><div class="k-sub">возвраты {{ fmtMoney(data.totals.returns) }} ₸</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #7c3aed"><el-icon><component is="Box" /></el-icon></span><div class="k-label">Себестоимость</div><div class="k-val">{{ fmtTenge(data.totals.cost) }}</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #23a047"><el-icon><component is="TrendCharts" /></el-icon></span><div class="k-label">Валовая прибыль</div><div class="k-val" :class="Number(data.totals.profit) < 0 ? 'bad' : 'ok'">{{ fmtTenge(data.totals.profit) }}</div>
          <div v-if="data.previous && Number(data.previous.netRevenue) === 0" class="k-sub">в прошлом периоде продаж не было</div>
          <div v-else-if="data.previous" class="k-sub">было {{ fmtMoney(data.previous.profit) }} ₸ <span :class="delta >= 0 ? 'ok' : 'bad'">{{ delta >= 0 ? '▲' : '▼' }} {{ Math.abs(delta).toFixed(1) }}%</span></div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #0f766e"><el-icon><component is="PieChart" /></el-icon></span><div class="k-label">Маржа / наценка</div><div class="k-val">{{ pct(data.totals.margin) }} / {{ pct(data.totals.markup) }}</div>
          <div v-if="data.previous && Number(data.previous.netRevenue)" class="k-sub">маржа была {{ pct(data.previous.margin) }}</div></div>
      </div>

      <el-table :data="rows" size="small" v-loading="loading" :empty-text="error || 'Продаж за период нет'" show-summary :summary-method="summary" :row-class-name="rowClass" :default-sort="{ prop: 'profitN', order: 'descending' }">
        <el-table-column :label="GROUPS.find((g) => g.key === groupBy)?.col" min-width="230" sortable :sort-by="(r: any) => r.name">
          <template #default="{ row }">
            <div class="nm">{{ row.name }}</div>
            <div v-if="row.code" class="muted small">{{ groupBy === 'document' ? fmtDate(row.code) : row.code }}</div>
          </template>
        </el-table-column>
        <el-table-column v-if="groupBy === 'product'" label="Продано" width="90" align="right" sortable :sort-by="(r: any) => Number(r.qty)"><template #default="{ row }">{{ fmtQty(row.qty) }}<span v-if="Number(row.returnsQty)" class="muted small"> (−{{ fmtQty(row.returnsQty) }})</span></template></el-table-column>
        <el-table-column v-else label="Док." width="70" align="right" prop="documents" sortable />
        <el-table-column label="Выручка" width="125" align="right" sortable :sort-by="(r: any) => Number(r.netRevenue)"><template #default="{ row }">{{ fmtMoney(row.netRevenue) }}<div v-if="Number(row.returns)" class="muted small">возвр. {{ fmtMoney(row.returns) }}</div></template></el-table-column>
        <el-table-column label="Себестоимость" width="125" align="right" sortable :sort-by="(r: any) => Number(r.cost)"><template #default="{ row }">{{ fmtMoney(row.cost) }}</template></el-table-column>
        <el-table-column label="Прибыль" prop="profitN" width="125" align="right" sortable :sort-by="(r: any) => Number(r.profit)">
          <template #default="{ row }"><b :class="Number(row.profit) < 0 ? 'bad' : ''">{{ fmtMoney(row.profit) }}</b>
            <div v-if="row.prevProfit !== null && Number(data?.previous?.netRevenue)" class="small" :class="Number(row.profit) >= Number(row.prevProfit) ? 'ok' : 'bad'">было {{ fmtMoney(row.prevProfit) }}</div></template>
        </el-table-column>
        <el-table-column label="Маржа" width="85" align="right" sortable :sort-by="(r: any) => r.margin ?? -1e9"><template #default="{ row }">{{ pct(row.margin) }}</template></el-table-column>
        <el-table-column label="Наценка" width="85" align="right" sortable :sort-by="(r: any) => r.markup ?? -1e9"><template #default="{ row }">{{ pct(row.markup) }}</template></el-table-column>
        <el-table-column label="Доля" width="75" align="right" sortable :sort-by="(r: any) => r.share ?? -1e9"><template #default="{ row }">{{ row.share === null ? '—' : `${row.share}%` }}</template></el-table-column>
        <el-table-column label="ABC" width="60" align="center">
          <template #default="{ row }"><el-tooltip :content="ABC[row.abc]" placement="top"><el-tag size="small" :type="row.abc === 'A' ? 'success' : row.abc === 'B' ? 'warning' : 'info'" effect="plain">{{ row.abc }}</el-tag></el-tooltip></template>
        </el-table-column>
      </el-table>
      <div class="hint">
        Данные учёта: выручка без НДС, себестоимость по партиям/средней (как в проводках). Маржа = прибыль / выручка, наценка = прибыль / себестоимость.
        ABC по прибыли: A — дают 80% прибыли, B — следующие 15%, C — остальные и убыточные.
        Сотрудник — ответственный документа или заказа-основания.
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { fmtDate, fmtMoney, fmtQty, fmtTenge, kzToday, shiftDay } from '@/utils/format'
import { downloadCsv } from '@/utils/csv'

const GROUPS = [
  { key: 'product', label: 'Товары', col: 'Товар' }, { key: 'group', label: 'Группы', col: 'Группа товаров' },
  { key: 'counterparty', label: 'Покупатели', col: 'Покупатель' }, { key: 'employee', label: 'Сотрудники', col: 'Сотрудник' },
  { key: 'store', label: 'Склады', col: 'Склад' }, { key: 'document', label: 'Документы', col: 'Документ' },
]
const ABC: Record<string, string> = { A: 'Главные: вместе дают 80% прибыли', B: 'Средние: следующие 15% прибыли', C: 'Малая доля прибыли или убыток' }
const today = kzToday()
const shortcuts = [
  { text: 'Этот месяц', value: () => [today.slice(0, 8) + '01', today] },
  { text: 'Прошлый месяц', value: () => { const e = shiftDay(today.slice(0, 8) + '01', -1); return [e.slice(0, 8) + '01', e] } },
  { text: '30 дней', value: () => [shiftDay(today, -29), today] },
  { text: 'Этот год', value: () => [today.slice(0, 4) + '-01-01', today] },
]
const groupBy = ref('product')
const range = ref<[string, string]>([today.slice(0, 8) + '01', today])
const compare = ref(true)
const search = ref('')
const onlyLoss = ref(false)
const loading = ref(false)
const error = ref('')
const data = ref<any>(null)

const rows = computed(() => {
  const q = search.value.trim().toLowerCase()
  return (data.value?.lines ?? []).filter((l: any) => (!q || `${l.name} ${l.code ?? ''}`.toLowerCase().includes(q)) && (!onlyLoss.value || l.lossMaking))
})
const delta = computed(() => {
  const p = Number(data.value?.previous?.profit ?? 0), c = Number(data.value?.totals?.profit ?? 0)
  return p === 0 ? 0 : ((c - p) / Math.abs(p)) * 100
})
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`)
const rowClass = ({ row }: any) => (row.lossMaking ? 'loss-row' : '')

function summary({ columns }: any) {
  const sum = (k: string) => fmtMoney(rows.value.reduce((a: number, r: any) => a + Number(r[k] || 0), 0))
  const map: Record<string, string> = { Выручка: sum('netRevenue'), Себестоимость: sum('cost'), Прибыль: sum('profit') }
  return columns.map((c: any, i: number) => (i === 0 ? 'Итого' : map[c.label] ?? ''))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.get('/accounting/reports/profitability', { params: { from: range.value[0], to: range.value[1], groupBy: groupBy.value, compare: compare.value ? '1' : undefined } })
  } catch (e: any) { data.value = null; error.value = e?.message || 'Не удалось построить отчёт' } finally { loading.value = false }
}

function exportCsv() {
  const head = [GROUPS.find((g) => g.key === groupBy.value)!.col, 'Код', 'Продано', 'Выручка', 'Возвраты', 'Себестоимость', 'Прибыль', 'Маржа, %', 'Наценка, %', 'ABC']
  downloadCsv(`прибыльность-${range.value[0]}-${range.value[1]}`, head, rows.value.map((r: any) => [r.name, r.code ?? '', r.qty, r.netRevenue, r.returns, r.cost, r.profit, r.margin ?? '', r.markup ?? '', r.abc]))
}

onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.kpi { background: var(--el-fill-color-light); border-radius: 8px; padding: 10px 14px; }
.k-label { color: var(--el-text-color-secondary); font-size: 12px; }
.k-val { font-size: 18px; font-weight: 600; margin-top: 2px; }
.k-sub { color: var(--el-text-color-secondary); font-size: 12px; }
.ok { color: var(--el-color-success); }
.bad { color: var(--el-color-danger); }
.nm { font-weight: 500; }
.muted { color: var(--el-text-color-secondary); }
.small { font-size: 11px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 10px; line-height: 1.5; }
:deep(.loss-row) { background: var(--el-color-danger-light-9); }
@media (max-width: 900px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
