<template>
  <div>
    <div class="page-header"><h1>{{ t('settlements') }}</h1></div>
    <el-card>
      <div class="filters">
        <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" />
        <el-input v-model="search" :placeholder="t('search')" clearable style="width: 240px;" />
        <el-button type="primary" @click="load" :loading="loading">{{ t('build') }}</el-button>
      </div>
      <el-table :data="rows" size="small" border show-summary :summary-method="summary" v-loading="loading" empty-text="Расчётов нет">
        <el-table-column :label="t('counterparty')" min-width="240">
          <template #default="{ row }">{{ row.name }} <span class="hint">{{ row.bin }}</span></template>
        </el-table-column>
        <el-table-column v-for="c in COLS" :key="c.key" :label="t(c.key)" width="160" align="right">
          <template #default="{ row }">
            <el-link v-if="Number(row[c.key])" :type="Number(row[c.key]) < 0 ? 'danger' : 'primary'" @click="card(row, c.account)">{{ fmtMoney(row[c.key]) }}</el-link>
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">Покупатели: 1210 (долг), 3510 (аванс получен). Поставщики: 3310 (долг), 1710 (аванс выдан). Отрицательный долг — переплата. Клик по сумме — карточка счёта по контрагенту.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useI18n } from '@/composables/useI18n'
import { addMoney, fmtMoney, showError } from './acc'

const router = useRouter()
const { t } = useI18n()
const COLS = [
  { key: 'receivable', account: '1210' }, { key: 'advanceReceived', account: '3510' },
  { key: 'payable', account: '3310' }, { key: 'advancePaid', account: '1710' },
]
const loading = ref(false)
const data = ref<any>(null)
const date = ref(dayjs().format('YYYY-MM-DD'))
const search = ref('')

const rows = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = data.value?.lines || []
  return q ? list.filter((l: any) => (l.name || '').toLowerCase().includes(q) || (l.bin || '').includes(q)) : list
})

function summary({ columns }: any) {
  return columns.map((_: any, i: number) => (i === 0 ? t('total') : fmtMoney(addMoney(rows.value.map((r: any) => r[COLS[i - 1].key])))))
}

function card(row: any, account: string) {
  router.push({ path: '/accounting/reports/account-card', query: { account, from: '2000-01-01', to: date.value, COUNTERPARTY: row.counterpartyId } })
}

async function load() {
  loading.value = true
  try { data.value = await api.get('/accounting/reports/settlements', { params: { date: date.value } }) } catch (e) { showError(e) }
  loading.value = false
}

onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.hint { color: #909399; font-size: 12px; margin-top: 8px; margin-left: 6px; }
</style>
