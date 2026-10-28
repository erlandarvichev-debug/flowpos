<template>
  <div>
    <div class="page-header">
      <h1>
        {{ t('trade') }}
        <el-badge v-if="issuesCount" :value="issuesCount" type="danger" style="margin-left: 10px;">
          <el-button size="small" type="danger" plain @click="router.push('/accounting/autopilot')">{{ t('issues') }}</el-button>
        </el-badge>
      </h1>
      <el-dropdown v-if="org.can('acc.doc.write')" @command="(c: string) => router.push({ path: '/accounting/trade/new', query: { type: c } })">
        <el-button type="primary" :icon="Plus">{{ t('create') }}</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="k in TRADE_CREATABLE" :key="k" :command="k" :divided="k === 'CUSTOMER_ORDER' || k === 'ENTER' || k === 'RETAIL_DEMAND'">{{ tl(k) }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <el-card>
      <div class="filters">
        <el-select v-model="f.docType" :placeholder="t('type')" clearable @change="reload" style="width: 220px;">
          <el-option v-for="(v, k) in TRADE_TYPES" :key="k" :label="lang === 'kk' ? v.kk : v.ru" :value="k" />
        </el-select>
        <el-select v-model="f.status" :placeholder="t('status')" clearable @change="reload" style="width: 180px;">
          <el-option v-for="s in ['DRAFT', 'POSTED', 'CANCELLED']" :key="s" :label="t(s)" :value="s" />
        </el-select>
        <el-date-picker v-model="f.range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="с" end-placeholder="по" @change="reload" style="width: 260px;" />
        <el-input v-model="f.search" :placeholder="`${t('search')}: номер, контрагент`" clearable @change="reload" style="width: 240px;" />
      </div>

      <el-table :data="items" v-loading="loading" @row-click="(r: any) => router.push(`/accounting/trade/${r.id}`)" style="cursor: pointer;" size="small">
        <el-table-column :label="t('date')" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
        <el-table-column :label="t('number')" prop="number" width="150" />
        <el-table-column :label="t('type')" min-width="170"><template #default="{ row }">{{ tl(row.docType) }}</template></el-table-column>
        <el-table-column :label="t('counterparty')" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ row.counterparty?.name }}</template></el-table-column>
        <el-table-column :label="t('amount')" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.total) }}</template></el-table-column>
        <el-table-column :label="t('status')" width="150">
          <template #default="{ row }"><el-tag :type="STATUS_TYPES[row.status] as any" size="small">{{ t(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column :label="t('accountingCol')" min-width="200">
          <template #default="{ row }">
            <el-tooltip v-if="row.accounting === 'ISSUE'" :content="`${row.issue?.message || ''} ${row.issue?.fix || ''}`" placement="top">
              <el-tag type="danger" size="small">{{ t('ISSUE') }}: {{ (row.issue?.message || '').slice(0, 40) }}…</el-tag>
            </el-tooltip>
            <el-tag v-else-if="row.accounting === 'REFLECTED'" type="success" size="small">{{ t('REFLECTED') }}</el-tag>
            <el-tag v-else type="info" size="small">{{ t('NONE') }}</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-if="total > limit" style="margin-top: 12px;" layout="total, prev, pager, next"
        :total="total" :page-size="limit" v-model:current-page="page" @current-change="load"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { STATUS_TYPES, TRADE_CREATABLE, TRADE_TYPES, fmtDate, fmtMoney, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const { t, lang } = useI18n()
const loading = ref(false)
const items = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const limit = 50
const issuesCount = ref(0)
const f = ref<any>({ docType: '', status: '', range: null, search: '' })

const tl = (k: string) => (TRADE_TYPES[k] ? TRADE_TYPES[k][lang.value] : k)

async function load() {
  loading.value = true
  try {
    const res = (await api.get('/accounting/trade-documents', {
      params: {
        docType: f.value.docType || undefined, status: f.value.status || undefined,
        from: f.value.range?.[0], to: f.value.range?.[1], search: f.value.search || undefined, page: page.value, limit,
      },
    })) as any
    items.value = res.items
    total.value = res.total
  } catch (e) { showError(e) }
  loading.value = false
}

async function loadIssues() {
  try { issuesCount.value = ((await api.get('/accounting/autopilot/status')) as any).openIssues || 0 } catch { issuesCount.value = 0 }
}

function reload() { page.value = 1; load() }

onMounted(() => { load(); loadIssues() })
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
</style>
