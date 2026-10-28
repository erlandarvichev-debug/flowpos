<template>
  <div>
    <div class="page-header">
      <h1>{{ t('documents') }}</h1>
      <el-dropdown v-if="org.can('acc.doc.write')" @command="(c: string) => router.push({ path: '/accounting/documents/new', query: { type: c } })">
        <el-button type="primary" :icon="Plus">{{ t('create') }}</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="MANUAL_OPERATION">Операция (вручную)</el-dropdown-item>
            <el-dropdown-item command="OPENING_BALANCE">Ввод начальных остатков</el-dropdown-item>
            <el-dropdown-item v-for="k in MONEY_DOC_TYPES" :key="k" :command="k" :divided="k === 'BANK_IN'">{{ DOC_TYPE_LABELS[k] }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <el-card>
      <div class="filters">
        <el-select v-model="f.docType" :placeholder="t('type')" clearable @change="reload" style="width: 220px;">
          <el-option v-for="(l, k) in DOC_TYPE_LABELS" :key="k" :label="l" :value="k" />
        </el-select>
        <el-select v-model="f.status" :placeholder="t('status')" clearable @change="reload" style="width: 180px;">
          <el-option v-for="s in ['DRAFT', 'POSTED', 'CANCELLED']" :key="s" :label="t(s)" :value="s" />
        </el-select>
        <el-date-picker v-model="f.range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="с" end-placeholder="по" @change="reload" style="width: 260px;" />
        <el-input v-model="f.search" :placeholder="t('search')" clearable @change="reload" style="width: 220px;" />
      </div>

      <el-table :data="items" v-loading="loading" @row-click="(r: any) => router.push(`/accounting/documents/${r.id}`)" style="cursor: pointer;" size="small">
        <el-table-column :label="t('date')" width="110"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
        <el-table-column :label="t('number')" prop="number" width="170" />
        <el-table-column :label="t('type')" min-width="180"><template #default="{ row }">{{ DOC_TYPE_LABELS[row.docType] || row.docType }}</template></el-table-column>
        <el-table-column :label="t('amount')" width="160" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
        <el-table-column :label="t('comment')" prop="comment" min-width="220" show-overflow-tooltip />
        <el-table-column :label="t('status')" width="160">
          <template #default="{ row }"><el-tag :type="STATUS_TYPES[row.status] as any" size="small">{{ t(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="Вер." prop="version" width="60" align="center" />
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
import { DOC_TYPE_LABELS, MONEY_DOC_TYPES, STATUS_TYPES, fmtDate, fmtMoney, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const { t } = useI18n()
const loading = ref(false)
const items = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const limit = 50
const f = ref<any>({ docType: '', status: '', range: null, search: '' })

async function load() {
  loading.value = true
  try {
    const res = (await api.get('/accounting/documents', {
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

function reload() { page.value = 1; load() }

onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
</style>
