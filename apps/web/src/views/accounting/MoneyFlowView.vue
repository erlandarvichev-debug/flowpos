<template>
  <div>
    <PageHeader title="Движение денег" subtitle="Откуда пришли и куда ушли деньги по банку и кассам (без переводов между своими счетами)">
      <el-button :icon="Download" :disabled="!data?.lines?.length" @click="exportCsv">CSV</el-button>
    </PageHeader>
    <el-card shadow="never">
      <div class="filters">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" unlink-panels :clearable="false" :shortcuts="shortcuts" style="width: 250px;" @change="load" />
        <el-radio-group v-model="by" @change="load">
          <el-radio-button value="item">По статьям</el-radio-button>
          <el-radio-button value="operation">По видам операций</el-radio-button>
        </el-radio-group>
      </div>
      <div v-if="data" class="kpis">
        <div class="kpi"><span class="kpi-ic" style="--c: #64748b"><el-icon><component is="Wallet" /></el-icon></span><div class="k-label">На начало</div><div class="k-val">{{ fmtTenge(data.opening) }}</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #23a047"><el-icon><component is="Bottom" /></el-icon></span><div class="k-label">Поступило</div><div class="k-val ok">+{{ fmtTenge(data.inflow) }}</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #dc2626"><el-icon><component is="Top" /></el-icon></span><div class="k-label">Выплачено</div><div class="k-val bad">−{{ fmtTenge(data.outflow) }}</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #1769e0"><el-icon><component is="Wallet" /></el-icon></span><div class="k-label">На конец</div><div class="k-val">{{ fmtTenge(data.closing) }}</div><div class="k-sub">за период {{ Number(data.net) >= 0 ? '+' : '' }}{{ fmtMoney(data.net) }} ₸</div></div>
      </div>
      <el-table :data="data?.lines ?? []" size="small" v-loading="loading" :empty-text="error || 'Движений денег нет'" border>
        <el-table-column :label="by === 'item' ? 'Статья / операция' : 'Вид операции'" min-width="220" fixed prop="name" />
        <el-table-column label="Поступления" width="125" align="right"><template #default="{ row }"><span class="ok">{{ m0(row.inflow) }}</span></template></el-table-column>
        <el-table-column label="Выплаты" width="125" align="right"><template #default="{ row }"><span class="bad">{{ m0(row.outflow) }}</span></template></el-table-column>
        <el-table-column label="Итог" width="125" align="right"><template #default="{ row }"><b :class="Number(row.net) < 0 ? 'bad' : 'ok'">{{ fmtMoney(row.net) }}</b></template></el-table-column>
        <el-table-column v-if="(data?.months?.length ?? 0) > 1" label="По месяцам" align="center">
          <el-table-column v-for="m in data.months" :key="m" :label="monthLabel(m)" width="110" align="right">
            <template #default="{ row }"><span :class="Number(row.months[m]) < 0 ? 'bad' : ''">{{ m0(row.months[m]) }}</span></template>
          </el-table-column>
        </el-table-column>
      </el-table>
      <div class="hint">Статью движения денег можно указать в платеже (поле «Статья»). Платежи без статьи показаны по виду операции.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Download } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { fmtMoney, fmtTenge, kzToday, shiftDay } from '@/utils/format'
import { downloadCsv } from '@/utils/csv'

const today = kzToday()
const shortcuts = [
  { text: 'Этот месяц', value: () => [today.slice(0, 8) + '01', today] },
  { text: 'Прошлый месяц', value: () => { const e = shiftDay(today.slice(0, 8) + '01', -1); return [e.slice(0, 8) + '01', e] } },
  { text: 'Квартал', value: () => [shiftDay(today, -89), today] },
  { text: 'Этот год', value: () => [today.slice(0, 4) + '-01-01', today] },
]
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`
const range = ref<[string, string]>([today.slice(0, 8) + '01', today])
const by = ref<'item' | 'operation'>('item')
const data = ref<any>(null)
const loading = ref(false)
const error = ref('')
const m0 = (v: any) => (Number(v) ? fmtMoney(v) : '')
async function load() {
  loading.value = true
  error.value = ''
  try { data.value = await api.get('/accounting/reports/money-flow', { params: { from: range.value[0], to: range.value[1], by: by.value } }) } catch (e: any) { data.value = null; error.value = e?.message || 'Не удалось построить отчёт' } finally { loading.value = false }
}
function exportCsv() {
  const ms = data.value.months as string[]
  downloadCsv(`движение-денег-${range.value[0]}-${range.value[1]}`, ['Статья', 'Поступления', 'Выплаты', 'Итог', ...ms], data.value.lines.map((l: any) => [l.name, l.inflow, l.outflow, l.net, ...ms.map((m) => l.months[m] ?? '')]))
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
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 10px; }
@media (max-width: 900px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
