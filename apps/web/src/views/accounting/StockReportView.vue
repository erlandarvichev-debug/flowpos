<template>
  <div>
    <div class="page-header"><h1>{{ t('stockReport') }}</h1></div>
    <el-card>
      <div class="filters">
        <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" />
        <el-select v-model="storeId" clearable :placeholder="`${t('store')}: все`" style="width: 240px;">
          <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-input v-model="search" :placeholder="t('search')" clearable style="width: 220px;" />
        <el-button type="primary" @click="load" :loading="loading">{{ t('build') }}</el-button>
      </div>
      <el-table :data="rows" size="small" border show-summary :summary-method="summary" @row-click="(r: any) => router.push(r.drill)" style="cursor: pointer;" v-loading="loading" empty-text="Остатков нет">
        <el-table-column :label="t('product')" prop="product" min-width="240" show-overflow-tooltip />
        <el-table-column :label="t('store')" prop="store" min-width="160" />
        <el-table-column :label="t('account')" prop="account" width="80" />
        <el-table-column :label="t('quantity')" width="120" align="right"><template #default="{ row }">{{ row.quantity }}</template></el-table-column>
        <el-table-column :label="t('unitCost')" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.unitCost) }}</template></el-table-column>
        <el-table-column :label="`${t('amount')}, ₸`" width="160" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
      </el-table>
      <div class="hint">Данные бухгалтерского учёта (счета запасов 1310/1320/1330/1350). Клик по строке — карточка счёта с документами.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useI18n } from '@/composables/useI18n'
import { fmtMoney, showError } from './acc'

const router = useRouter()
const { t } = useI18n()
const loading = ref(false)
const data = ref<any>(null)
const stores = ref<any[]>([])
const date = ref(dayjs().format('YYYY-MM-DD'))
const storeId = ref<string>()
const search = ref('')

const rows = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = data.value?.lines || []
  return q ? list.filter((l: any) => (l.product || '').toLowerCase().includes(q)) : list
})

function summary({ columns }: any) {
  return columns.map((_: any, i: number) => (i === 0 ? t('total') : i === columns.length - 1 ? fmtMoney(data.value?.total) : ''))
}

async function load() {
  loading.value = true
  try { data.value = await api.get('/accounting/reports/stock', { params: { date: date.value, storeId: storeId.value || undefined } }) } catch (e) { showError(e) }
  loading.value = false
}

onMounted(async () => {
  try { stores.value = (await api.get('/catalog/warehouses')) as any } catch { /* ignore */ }
  load()
})
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.hint { color: #909399; font-size: 12px; margin-top: 8px; }
</style>
