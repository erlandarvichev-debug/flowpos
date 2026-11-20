<template>
  <!-- «Супервайзер»: план и факт по представителям за период. -->
  <div>
    <div class="page-header"><h1>План и факт</h1></div>
    <el-card>
      <div class="filters">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" range-separator="—" :clearable="false" @change="load" />
        <span class="muted">Период — не больше трёх месяцев. Сутки — по времени Казахстана.</span>
      </div>
      <el-table :data="rows" v-loading="loading" size="small" empty-text="Нет данных за период" show-summary :summary-method="summary">
        <el-table-column label="Представитель" min-width="180"><template #default="{ row }">{{ row.rep.name }}</template></el-table-column>
        <el-table-column label="В маршрутах" width="110" align="right" prop="planned" />
        <el-table-column label="Посещено из плана" width="140" align="right">
          <template #default="{ row }">{{ row.visitedPlanned }}<span class="muted" v-if="row.planned"> ({{ Math.round((row.visitedPlanned / row.planned) * 100) }}%)</span></template>
        </el-table-column>
        <el-table-column label="Пропущено" width="100" align="right"><template #default="{ row }"><span :class="{ bad: row.missed }">{{ row.missed }}</span></template></el-table-column>
        <el-table-column label="Вне маршрута" width="110" align="right" prop="extraVisits" />
        <el-table-column label="На точке" width="90" align="right" prop="onSite" />
        <el-table-column label="Удалённо" width="90" align="right"><template #default="{ row }"><span :class="{ warn: row.remote }">{{ row.remote }}</span></template></el-table-column>
        <el-table-column label="Не опр." width="80" align="right" prop="unknown" />
        <el-table-column label="Заказов" width="90" align="right" prop="orders" />
        <el-table-column label="Сумма заказов" width="140" align="right"><template #default="{ row }">{{ fmtSum(row.ordersSum) }}</template></el-table-column>
        <el-table-column label="Заказов удалённо" width="130" align="right" prop="ordersRemote" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { fmtSum, kzToday } from './field'

const today = kzToday()
const range = ref<[string, string]>([`${today.slice(0, 8)}01`, today])
const rows = ref<any[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try { rows.value = (await api.get('/field/plan-fact', { params: { from: range.value[0], to: range.value[1] } })) as any } catch (e) { showError(e) }
  loading.value = false
}

const NUM = ['planned', 'visitedPlanned', 'missed', 'extraVisits', 'onSite', 'remote', 'unknown', 'orders', 'ordersSum', 'ordersRemote']
function summary({ columns }: any) {
  const keys = [null, ...NUM]
  return columns.map((_: any, i: number) => {
    if (i === 0) return 'Итого'
    const k = keys[i]
    if (!k) return ''
    const total = rows.value.reduce((s, r) => s + Number(r[k] || 0), 0)
    return k === 'ordersSum' ? fmtSum(total) : String(total)
  })
}

onMounted(load)
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.muted { color: #909399; font-size: 12px; }
.bad { color: #f56c6c; font-weight: 600; }
.warn { color: #e6a23c; font-weight: 600; }
</style>
