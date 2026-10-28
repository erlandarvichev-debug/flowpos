<template>
  <div>
    <div class="page-header"><h1>{{ t('trialBalance') }}</h1></div>
    <el-card>
      <div class="filters">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 260px;" />
        <el-radio-group v-model="ledger">
          <el-radio-button value="BU">Бух. учёт</el-radio-button>
          <el-radio-button value="NU">Налог. учёт</el-radio-button>
        </el-radio-group>
        <el-checkbox v-model="sectionsOnly">Только разделы</el-checkbox>
        <el-checkbox v-model="withSections">С разделами</el-checkbox>
        <el-button type="primary" @click="load" :loading="loading">{{ t('build') }}</el-button>
        <el-button @click="exportXlsx" :loading="exporting">Excel</el-button>
      </div>

      <el-alert v-for="w in data?.warnings || []" :key="w" type="error" :title="w" :closable="false" show-icon style="margin-bottom: 8px;" />
      <el-alert v-if="data && data.balanced" type="success" title="Баланс сходится: Дт = Кт по сальдо и оборотам" :closable="false" show-icon style="margin-bottom: 8px;" />

      <el-table :data="rows" size="small" border v-loading="loading" @row-click="drill" :row-class-name="rowClass" style="cursor: pointer;" show-summary :summary-method="summary">
        <el-table-column :label="t('account')" min-width="300" fixed>
          <template #default="{ row }"><b>{{ row.code }}</b> {{ nm(row) }}</template>
        </el-table-column>
        <el-table-column :label="t('opening')" align="center">
          <el-table-column :label="t('debit')" width="140" align="right"><template #default="{ row }">{{ z(row.opening.debit) }}</template></el-table-column>
          <el-table-column :label="t('credit')" width="140" align="right"><template #default="{ row }">{{ z(row.opening.credit) }}</template></el-table-column>
        </el-table-column>
        <el-table-column :label="t('turnover')" align="center">
          <el-table-column :label="t('debit')" width="140" align="right"><template #default="{ row }">{{ z(row.turnover.debit) }}</template></el-table-column>
          <el-table-column :label="t('credit')" width="140" align="right"><template #default="{ row }">{{ z(row.turnover.credit) }}</template></el-table-column>
        </el-table-column>
        <el-table-column :label="t('closing')" align="center">
          <el-table-column :label="t('debit')" width="140" align="right"><template #default="{ row }">{{ z(row.closing.debit) }}</template></el-table-column>
          <el-table-column :label="t('credit')" width="140" align="right"><template #default="{ row }">{{ z(row.closing.credit) }}</template></el-table-column>
        </el-table-column>
      </el-table>
      <div class="hint">Клик по счёту — карточка счёта с расшифровкой до проводок и документов.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useI18n } from '@/composables/useI18n'
import { fmtMoney, showError } from './acc'

const route = useRoute()
const router = useRouter()
const { t, nm } = useI18n()
const loading = ref(false)
const data = ref<any>(null)
const range = ref<[string, string]>([
  (route.query.from as string) || dayjs().startOf('month').format('YYYY-MM-DD'),
  (route.query.to as string) || dayjs().endOf('month').format('YYYY-MM-DD'),
])
const ledger = ref<'BU' | 'NU'>((route.query.ledger as any) === 'NU' ? 'NU' : 'BU')
const sectionsOnly = ref(false)
const withSections = ref(true)

const rows = computed(() => {
  const lines = data.value?.lines || []
  if (sectionsOnly.value) return lines.filter((l: any) => l.isGroup && !l.parentId)
  return withSections.value ? lines : lines.filter((l: any) => !l.isGroup)
})

const z = (v: string) => (Number(v) ? fmtMoney(v) : '')

function rowClass({ row }: { row: any }) { return row.isGroup ? 'group-row' : '' }

function summary() {
  const tt = data.value?.totals
  if (!tt) return []
  return [t('total'), fmtMoney(tt.opening.debit), fmtMoney(tt.opening.credit), fmtMoney(tt.turnover.debit), fmtMoney(tt.turnover.credit), fmtMoney(tt.closing.debit), fmtMoney(tt.closing.credit)]
}

function drill(row: any) {
  router.push({ path: '/accounting/reports/account-card', query: { account: row.code, from: range.value[0], to: range.value[1], ledger: ledger.value } })
}

const exporting = ref(false)
async function exportXlsx() {
  exporting.value = true
  try {
    const blob = (await api.get('/accounting/reports/trial-balance/export', { params: { from: range.value[0], to: range.value[1], ledger: ledger.value }, responseType: 'blob' })) as unknown as Blob
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `osv_${range.value[0]}_${range.value[1]}.xlsx`
    a.click()
    URL.revokeObjectURL(a.href)
  } catch (e) { showError(e) }
  exporting.value = false
}

async function load() {
  loading.value = true
  try {
    data.value = await api.get('/accounting/reports/trial-balance', { params: { from: range.value[0], to: range.value[1], ledger: ledger.value } })
    router.replace({ query: { from: range.value[0], to: range.value[1], ledger: ledger.value } })
  } catch (e) { showError(e) }
  loading.value = false
}

onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 14px; }
.hint { margin-top: 10px; color: #909399; font-size: 12px; }
:deep(.group-row) { background: #f5f7fa; font-weight: 600; }
</style>
