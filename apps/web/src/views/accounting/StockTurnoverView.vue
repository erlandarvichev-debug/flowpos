<template>
  <div>
    <PageHeader title="Обороты товаров" subtitle="Остаток на начало, приход, расход и остаток на конец — количество и себестоимость">
      <el-button :icon="Download" :disabled="!rows.length" @click="exportCsv">CSV</el-button>
    </PageHeader>
    <el-card shadow="never">
      <div class="filters">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" unlink-panels :clearable="false" style="width: 250px;" @change="load" />
        <el-select v-model="storeId" clearable placeholder="Все склады" style="width: 200px;" @change="load">
          <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-input v-model="search" placeholder="Товар, артикул" clearable style="width: 220px;" :prefix-icon="Search" />
        <el-checkbox v-model="onlyMoving">Только с движением</el-checkbox>
      </div>
      <el-table :data="rows" size="small" v-loading="loading" :empty-text="error || 'Движений нет'" show-summary :summary-method="summary" border>
        <el-table-column label="Товар" min-width="220" fixed>
          <template #default="{ row }"><div>{{ row.name }}</div><div v-if="row.code" class="muted small">{{ row.code }}</div></template>
        </el-table-column>
        <el-table-column v-for="g in GROUPS" :key="g.k" :label="g.label" align="center">
          <el-table-column label="Кол-во" width="90" align="right"><template #default="{ row }"><span :class="{ neg: Number(row[g.k + 'Qty']) < 0 }">{{ q0(row[g.k + 'Qty']) }}</span> <span v-if="Number(row[g.k + 'Qty'])" class="muted small">{{ row.unit }}</span></template></el-table-column>
          <el-table-column label="Сумма" width="115" align="right"><template #default="{ row }">{{ m0(row[g.k + 'Sum']) }}</template></el-table-column>
        </el-table-column>
      </el-table>
      <div class="hint">По данным учёта (счета запасов). Перемещения между складами видны при выборе склада. Отрицательный остаток подсвечен.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { fmtMoney, fmtQty, kzToday } from '@/utils/format'
import { downloadCsv } from '@/utils/csv'

const GROUPS = [{ k: 'open', label: 'На начало' }, { k: 'in', label: 'Приход' }, { k: 'out', label: 'Расход' }, { k: 'close', label: 'На конец' }]
const today = kzToday()
const range = ref<[string, string]>([today.slice(0, 8) + '01', today])
const storeId = ref('')
const stores = ref<any[]>([])
const search = ref('')
const onlyMoving = ref(false)
const data = ref<any>(null)
const loading = ref(false)
const error = ref('')
const q0 = (v: any) => (Number(v) ? fmtQty(v) : '')
const m0 = (v: any) => (Number(v) ? fmtMoney(v) : '')

const rows = computed(() => {
  const s = search.value.trim().toLowerCase()
  return (data.value?.lines ?? []).filter((l: any) => (!s || `${l.name} ${l.code ?? ''}`.toLowerCase().includes(s)) && (!onlyMoving.value || Number(l.inQty) || Number(l.outQty)))
})
function summary({ columns }: any) {
  const sums = ['openSum', 'inSum', 'outSum', 'closeSum'].map((k) => fmtMoney(rows.value.reduce((a: number, r: any) => a + Number(r[k] || 0), 0)))
  // колонки: товар, (кол-во, сумма) × 4
  return columns.map((_: any, i: number) => (i === 0 ? 'Итого' : i % 2 === 0 ? sums[i / 2 - 1] : ''))
}
async function load() {
  loading.value = true
  error.value = ''
  try { data.value = await api.get('/accounting/reports/stock-turnover', { params: { from: range.value[0], to: range.value[1], storeId: storeId.value || undefined } }) } catch (e: any) { data.value = null; error.value = e?.message || 'Не удалось построить отчёт' } finally { loading.value = false }
}
function exportCsv() {
  downloadCsv(`обороты-товаров-${range.value[0]}-${range.value[1]}`, ['Товар', 'Артикул', 'Ед.', 'Начало кол-во', 'Начало сумма', 'Приход кол-во', 'Приход сумма', 'Расход кол-во', 'Расход сумма', 'Конец кол-во', 'Конец сумма'],
    rows.value.map((r: any) => [r.name, r.code ?? '', r.unit, r.openQty, r.openSum, r.inQty, r.inSum, r.outQty, r.outSum, r.closeQty, r.closeSum]))
}
onMounted(async () => {
  load()
  try { stores.value = (await api.get('/catalog/warehouses')) as any[] } catch { stores.value = [] }
})
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.muted { color: var(--el-text-color-secondary); }
.small { font-size: 11px; }
.neg { color: var(--el-color-danger); font-weight: 600; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 10px; }
</style>
