<template>
  <div>
    <div class="page-header"><h1>{{ t('accountCard') }} <span v-if="data" class="sub">{{ data.account.code }} {{ nm(data.account) }}</span></h1></div>
    <el-card>
      <div class="filters">
        <AccountSelect v-model="account" :accounts="accountsAll" style="width: 280px;" />
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 260px;" />
        <el-radio-group v-model="ledger">
          <el-radio-button value="BU">БУ</el-radio-button>
          <el-radio-button value="NU">НУ</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="load" :loading="loading" :disabled="!account">{{ t('build') }}</el-button>
      </div>

      <template v-if="data">
        <div class="saldo">{{ t('opening') }}: <b>{{ bal(data.opening) }}</b></div>
        <el-table :data="data.lines" size="small" border @row-click="openDoc" style="cursor: pointer;">
          <el-table-column :label="t('date')" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
          <el-table-column label="Документ" min-width="200">
            <template #default="{ row }">
              <span v-if="row.source.number">{{ DOC_TYPE_LABELS[row.source.docType] || row.source.docType }} {{ row.source.number }}</span>
              <span v-else-if="row.source.type === 'TRADE_DOCUMENT'">Торговый документ</span>
              <span v-else-if="row.source.type === 'COST'">Себестоимость ({{ TRADE_TYPES[row.source.id?.split(':')[0]]?.ru || 'документ' }})</span>
              <span v-else>{{ row.source.type }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Счёт" prop="account" width="80" />
          <el-table-column :label="t('corr')" prop="corrAccounts" width="110" />
          <el-table-column :label="t('debit')" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.debit) }}</template></el-table-column>
          <el-table-column :label="t('credit')" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.credit) }}</template></el-table-column>
          <el-table-column v-if="data.account.isQuantitative" label="Кол-во" width="100" align="right" prop="quantity" />
          <el-table-column :label="t('balance')" width="170" align="right"><template #default="{ row }">{{ bal(row.balance) }}</template></el-table-column>
          <el-table-column v-if="data.account.isQuantitative" label="Остаток кол." width="110" align="right" prop="quantityBalance" />
          <el-table-column label="Аналитика" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ Object.values(row.dimNames || {}).join(' · ') }}</template>
          </el-table-column>
          <el-table-column label="Содержание" prop="memo" min-width="160" show-overflow-tooltip />
        </el-table>
        <div class="saldo">
          {{ t('turnover') }}: Дт <b>{{ fmtMoney(data.turnover.debit) }}</b>, Кт <b>{{ fmtMoney(data.turnover.credit) }}</b>
          &nbsp;·&nbsp; {{ t('closing') }}: <b>{{ bal(data.closing) }}</b>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useI18n } from '@/composables/useI18n'
import AccountSelect from '@/components/accounting/AccountSelect.vue'
import { DOC_TYPE_LABELS, TRADE_TYPES, fmtDate, fmtMoney, showError, sourceLink } from './acc'

const route = useRoute()
const router = useRouter()
const { t, nm } = useI18n()
const loading = ref(false)
const data = ref<any>(null)
const accountsAll = ref<any[]>([])
const account = ref<string>((route.query.account as string) || '')
const range = ref<[string, string]>([
  (route.query.from as string) || dayjs().startOf('month').format('YYYY-MM-DD'),
  (route.query.to as string) || dayjs().endOf('month').format('YYYY-MM-DD'),
])
const ledger = ref<'BU' | 'NU'>((route.query.ledger as any) === 'NU' ? 'NU' : 'BU')

function bal(b: any) {
  if (!b) return ''
  if (Number(b.debit)) return `Дт ${fmtMoney(b.debit)}`
  if (Number(b.credit)) return `Кт ${fmtMoney(b.credit)}`
  return '0,00'
}

function openDoc(row: any) { const l = sourceLink(row.source); if (l) router.push(l) }

async function load() {
  if (!account.value) return
  loading.value = true
  try {
    data.value = await api.get('/accounting/reports/account-card', { params: { ...route.query, account: account.value, from: range.value[0], to: range.value[1], ledger: ledger.value } })
    router.replace({ query: { ...route.query, account: account.value, from: range.value[0], to: range.value[1], ledger: ledger.value } })
  } catch (e) { showError(e) }
  loading.value = false
}

onMounted(async () => {
  try {
    const all = (await api.get('/accounting/chart')) as any[]
    accountsAll.value = all.map((a) => ({ ...a, isGroup: false }))
  } catch (e) { showError(e) }
  load()
})
</script>

<style scoped>
.sub { font-weight: 400; color: #606266; margin-left: 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 14px; }
.saldo { margin: 10px 0; color: #303133; }
</style>
