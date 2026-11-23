<template>
  <div>
    <PageHeader :title="journal ? String(route.meta.title) : t('documents')" :subtitle="total ? `${total.toLocaleString('ru-RU')} ${plural(total, 'документ', 'документа', 'документов')}` : ''">
      <el-dropdown v-if="org.can('acc.doc.write')" @command="(c: string) => router.push({ path: '/accounting/documents/new', query: { type: c } })">
        <el-button type="primary" :icon="Plus">{{ t('create') }}</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="k in creatable" :key="k" :command="k" :divided="!journal && k === 'BANK_IN'">{{ DOC_TYPE_LABELS[k] }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </PageHeader>

    <el-card shadow="never">
      <DataTable
        :columns="columns" :rows="items" :loading="loading" :error="error" :total="total" v-model:page="page" v-model:limit="limit"
        :storage-key="`acc-docs:${String(route.name)}`" clickable :export-name="exportName" :fetch-all="fetchAll"
        :unit="['документ', 'документа', 'документов']" :empty-text="hasFilters ? 'Ничего не найдено — измените фильтры' : 'Документов пока нет'"
        @row-click="(r: any) => router.push(`/accounting/documents/${r.id}`)" @retry="load"
      >
        <template #filters>
          <el-input v-model="f.search" :prefix-icon="Search" :placeholder="`${t('search')}: номер, комментарий`" clearable class="w-search" @input="onSearch" @clear="reload" />
          <el-date-picker v-model="f.range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" start-placeholder="с" end-placeholder="по" unlink-panels class="w-range" @change="reload" />
          <el-select v-if="!journal || journal.length > 1" v-model="f.docType" :placeholder="t('type')" clearable class="w-type" @change="reload">
            <el-option v-for="k in typeOptions" :key="k" :label="DOC_TYPE_LABELS[k] || k" :value="k" />
          </el-select>
          <el-select v-model="f.status" :placeholder="t('status')" clearable class="w-status" @change="reload">
            <el-option v-for="s in ['DRAFT', 'POSTED', 'CANCELLED']" :key="s" :label="t(s)" :value="s" />
          </el-select>
          <el-button v-if="hasFilters" link type="primary" @click="clearFilters">Сбросить</el-button>
        </template>
        <template #cell-docType="{ row }">{{ DOC_TYPE_LABELS[row.docType] || row.docType }}</template>
        <template #cell-amount="{ row }"><span class="money">{{ fmtMoney(row.amount) }}</span></template>
        <template #cell-status="{ row }"><el-tag :type="STATUS_TYPES[row.status] as any" size="small" effect="light">{{ t(row.status) }}</el-tag></template>
      </DataTable>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import PageHeader from '@/components/ui/PageHeader.vue'
import DataTable, { type Col } from '@/components/ui/DataTable.vue'
import { fmtDate, fmtMoney, plural } from '@/utils/format'
import { DOC_TYPE_LABELS, MONEY_DOC_TYPES, STATUS_TYPES } from './acc'

const router = useRouter()
const route = useRoute()
/** Журнал раздела (Банк и касса → Банковские выписки и т. п.): только эти виды документов. */
const journal = computed(() => (route.meta.docTypes as string[] | undefined) ?? null)
const typeOptions = computed(() => journal.value ?? Object.keys(DOC_TYPE_LABELS))
const ALL_CREATABLE = ['MANUAL_OPERATION', 'OPENING_BALANCE', ...MONEY_DOC_TYPES]
const creatable = computed(() => (journal.value ? ALL_CREATABLE.filter((k) => journal.value!.includes(k)) : ALL_CREATABLE))
const org = useOrgStore()
const { t } = useI18n()
const loading = ref(false)
const error = ref('')
const items = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const limit = ref(50)
const f = ref<any>({ docType: '', status: '', range: null, search: '' })

const columns = computed<Col[]>(() => [
  { key: 'date', label: t('date'), width: 110, value: (r) => fmtDate(r.date) },
  { key: 'number', label: t('number'), width: 170 },
  { key: 'docType', label: t('type'), minWidth: 180, hidden: !!journal.value && journal.value.length === 1, export: (r) => DOC_TYPE_LABELS[r.docType] || r.docType },
  { key: 'amount', label: `${t('amount')}, ₸`, width: 150, align: 'right', export: (r) => (r.amount === null ? '' : String(r.amount)) },
  { key: 'comment', label: t('comment'), minWidth: 220, ellipsis: true },
  { key: 'status', label: t('status'), width: 150, export: (r) => t(r.status) },
  { key: 'version', label: 'Версия', width: 80, align: 'center', hidden: true },
])
const hasFilters = computed(() => !!(f.value.docType || f.value.status || f.value.range || f.value.search))
const exportName = computed(() => (journal.value ? String(route.meta.title) : 'документы-учёта').toLowerCase().replace(/\s+/g, '-'))

const params = (extra: Record<string, unknown> = {}) => ({
  docType: f.value.docType || journal.value?.join(',') || undefined, status: f.value.status || undefined,
  from: f.value.range?.[0], to: f.value.range?.[1], search: f.value.search || undefined, page: page.value, limit: limit.value, ...extra,
})

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  error.value = ''
  try {
    const res = (await api.get('/accounting/documents', { params: params() })) as any
    if (my !== seq) return
    items.value = res.items
    total.value = res.total
  } catch (e: any) {
    if (my === seq) error.value = e?.message || 'Не удалось загрузить документы'
  } finally {
    if (my === seq) loading.value = false
  }
}
function reload() { if (page.value !== 1) page.value = 1; else load() }
watch([page, limit], () => load())
let timer: ReturnType<typeof setTimeout> | undefined
function onSearch() { clearTimeout(timer); timer = setTimeout(reload, 350) }
function clearFilters() { f.value = { docType: '', status: '', range: null, search: '' }; reload() }
async function fetchAll() {
  const all: any[] = []
  for (let p = 1; p <= 50; p++) {
    const res = (await api.get('/accounting/documents', { params: params({ page: p, limit: 200 }) })) as any
    all.push(...res.items)
    if (all.length >= res.total || !res.items.length) break
  }
  return all
}

onMounted(load)
</script>

<style scoped>
.w-search { width: 260px; }
.w-range { width: 250px !important; flex: 0 0 auto; }
.w-type { width: 220px; }
.w-status { width: 150px; }
.money { font-variant-numeric: tabular-nums; font-weight: 500; }
@media (max-width: 640px) { .w-search, .w-range, .w-type, .w-status { width: 100% !important; } }
</style>
