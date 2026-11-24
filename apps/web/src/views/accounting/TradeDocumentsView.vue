<template>
  <div>
    <PageHeader :title="journal ? String(route.meta.title) : t('trade')" :subtitle="subtitle">
      <template #badge>
        <el-badge v-if="issuesCount" :value="issuesCount" type="danger">
          <el-button size="small" type="danger" plain @click="router.push('/accounting/autopilot')">{{ t('issues') }}</el-button>
        </el-badge>
      </template>
      <el-button v-if="org.can('acc.doc.write') && creatable.length === 1" type="primary" :icon="Plus" @click="create(creatable[0])">{{ t('create') }}</el-button>
      <el-dropdown v-else-if="org.can('acc.doc.write') && creatable.length" @command="create">
        <el-button type="primary" :icon="Plus">{{ t('create') }}</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="k in creatable" :key="k" :command="k" :divided="!journal && (k === 'CUSTOMER_ORDER' || k === 'ENTER' || k === 'RETAIL_DEMAND')">{{ tl(k) }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </PageHeader>

    <el-card shadow="never">
      <DataTable
        :columns="columns" :rows="items" :loading="loading" :error="error" :total="total" v-model:page="page" v-model:limit="limit" v-model:sort="sort"
        :storage-key="`trade-docs:${String(route.name)}`" clickable :export-name="exportName" :fetch-all="fetchAll" :summary="summary"
        :unit="['документ', 'документа', 'документов']" :empty-text="hasFilters ? 'Ничего не найдено — измените фильтры' : 'Документов пока нет'"
        @row-click="(r: any) => router.push(`/accounting/trade/${r.id}`)" @retry="load"
      >
        <template #filters>
          <el-input v-model="f.search" :prefix-icon="Search" placeholder="Номер, контрагент, комментарий" clearable class="w-search" @input="onSearch" @clear="reload" />
          <el-date-picker v-model="f.range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" start-placeholder="с" end-placeholder="по" unlink-panels :shortcuts="shortcuts" class="w-range" @change="reload" />
          <el-select v-if="!journal || journal.length > 1" v-model="f.docType" :placeholder="t('type')" clearable class="w-type" @change="reload">
            <el-option v-for="k in typeOptions" :key="k" :label="tl(k)" :value="k" />
          </el-select>
          <el-select v-model="f.status" :placeholder="t('status')" clearable class="w-status" @change="reload">
            <el-option v-for="s in ['DRAFT', 'POSTED', 'CANCELLED']" :key="s" :label="t(s)" :value="s" />
          </el-select>
          <el-button :type="more ? 'primary' : 'default'" plain :icon="Filter" @click="more = !more">Ещё<span v-if="moreCount" class="cnt">{{ moreCount }}</span></el-button>
          <template v-if="more">
            <el-select v-model="f.counterpartyId" filterable remote clearable :remote-method="findCp" :loading="cpLoading" placeholder="Контрагент" class="w-cp" @change="reload">
              <el-option v-for="c in cps" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
            <el-select v-model="f.storeId" clearable placeholder="Склад" class="w-store" @change="reload">
              <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
            <el-select v-model="f.productId" filterable remote clearable :remote-method="findProduct" :loading="prLoading" placeholder="Товар в документе" class="w-cp" @change="reload">
              <el-option v-for="p in products" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
          </template>
          <el-button v-if="hasFilters" link type="primary" @click="clearFilters">Сбросить</el-button>
        </template>

        <template #cell-number="{ row }"><span class="num">{{ row.number || '—' }}</span></template>
        <template #cell-docType="{ row }">{{ tl(row.docType) }}</template>
        <template #cell-counterparty="{ row }">{{ row.counterparty?.name || '—' }}</template>
        <template #cell-total="{ row }"><span class="money">{{ fmtMoney(row.total) }}</span></template>
        <template #cell-status="{ row }">
          <el-tag :type="STATUS_TYPES[row.status] as any" size="small" effect="light">{{ t(row.status) }}</el-tag>
          <el-tag v-if="row.attributes?.closed" size="small" type="info" class="ml">закрыт</el-tag>
        </template>
        <template #cell-payment="{ row }">
          <template v-if="row.payment">
            <el-tag v-if="row.payment.status === 'PAID'" type="success" size="small" effect="plain">оплачен</el-tag>
            <el-tooltip v-else :content="`Оплачено ${fmtMoney(row.payment.paid)} ₸, осталось ${fmtMoney(row.payment.debt)} ₸`" placement="top">
              <span :class="row.payment.status === 'PARTIAL' ? 'pay-part' : 'pay-no'">{{ fmtMoney(row.payment.debt) }}</span>
            </el-tooltip>
          </template>
          <span v-else class="muted">—</span>
        </template>
        <template #cell-accounting="{ row }">
          <el-tooltip v-if="row.accounting === 'ISSUE'" :content="`${row.issue?.message || ''} ${row.issue?.fix || ''}`" placement="top">
            <el-tag type="danger" size="small">{{ t('ISSUE') }}</el-tag>
          </el-tooltip>
          <el-tag v-else-if="row.accounting === 'REFLECTED'" type="success" size="small" effect="plain">{{ t('REFLECTED') }}</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </DataTable>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Filter, Plus, Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import PageHeader from '@/components/ui/PageHeader.vue'
import DataTable, { type Col } from '@/components/ui/DataTable.vue'
import { fmtDate, fmtMoney, kzToday, shiftDay } from '@/utils/format'
import { STATUS_TYPES, TRADE_CREATABLE, TRADE_TYPES } from './acc'

const router = useRouter()
const route = useRoute()
/** Журнал раздела (Продажи → Реализации и т. п.): только эти виды документов. */
const journal = computed(() => (route.meta.docTypes as string[] | undefined) ?? null)
const typeOptions = computed(() => journal.value ?? Object.keys(TRADE_TYPES))
const creatable = computed(() => (journal.value ? TRADE_CREATABLE.filter((k) => journal.value!.includes(k)) : TRADE_CREATABLE))
const org = useOrgStore()
const { t, lang } = useI18n()
const tl = (k: string) => (TRADE_TYPES[k] ? TRADE_TYPES[k][lang.value] : k)

const q = route.query
const loading = ref(false)
const error = ref('')
const items = ref<any[]>([])
const total = ref(0)
const sum = ref('0')
const page = ref(Number(q.page) || 1)
const limit = ref(50)
const sort = ref(String(q.sort || 'date_desc'))
const issuesCount = ref(0)
const more = ref(!!(q.counterpartyId || q.storeId || q.productId))
const f = ref<any>({
  docType: String(q.docType || ''), status: String(q.status || ''), search: String(q.search || ''),
  range: q.from && q.to ? [String(q.from), String(q.to)] : null,
  counterpartyId: String(q.counterpartyId || ''), storeId: String(q.storeId || ''), productId: String(q.productId || ''),
})

const columns = computed<Col[]>(() => [
  { key: 'date', label: t('date'), width: 110, sortable: true, value: (r) => fmtDate(r.date), export: (r) => fmtDate(r.date) },
  { key: 'number', label: t('number'), width: 150, sortable: true, export: (r) => r.number },
  { key: 'docType', label: t('type'), minWidth: 160, hidden: !!journal.value && journal.value.length === 1, export: (r) => tl(r.docType) },
  { key: 'counterparty', label: t('counterparty'), minWidth: 200, sortable: true, ellipsis: true, export: (r) => r.counterparty?.name ?? '' },
  { key: 'store', label: 'Склад', minWidth: 140, hidden: true, value: (r) => r.store?.name, export: (r) => r.store?.name ?? '' },
  { key: 'total', label: `${t('amount')}, ₸`, width: 150, align: 'right', sortable: true, export: (r) => (r.total === null ? '' : String(r.total)) },
  { key: 'status', label: t('status'), width: 150, export: (r) => t(r.status) },
  { key: 'payment', label: 'К оплате, ₸', width: 130, align: 'right', hidden: !!journal.value && !journal.value.some((k) => k === 'DEMAND' || k === 'SUPPLY'), export: (r) => (r.payment ? (r.payment.status === 'PAID' ? '0' : r.payment.debt) : '') },
  { key: 'accounting', label: t('accountingCol'), width: 140, hidden: !org.can('acc.reports.read'), export: (r) => t(r.accounting) },
  { key: 'comment', label: 'Комментарий', minWidth: 180, hidden: true, ellipsis: true, export: (r) => r.comment ?? '' },
])

const hasFilters = computed(() => !!(f.value.docType || f.value.status || f.value.search || f.value.range || f.value.counterpartyId || f.value.storeId || f.value.productId))
const moreCount = computed(() => [f.value.counterpartyId, f.value.storeId, f.value.productId].filter(Boolean).length)
const summary = computed(() => (total.value ? { total: fmtMoney(sum.value) } : undefined))
const subtitle = computed(() => (total.value ? `${total.value.toLocaleString('ru-RU')} шт. на ${fmtMoney(sum.value)} ₸ (без помеченных на удаление)` : ''))
const exportName = computed(() => (journal.value ? String(route.meta.title) : 'документы').toLowerCase().replace(/\s+/g, '-'))

const shortcuts = [
  { text: 'Сегодня', value: () => { const d = kzToday(); return [d, d] } },
  { text: 'Вчера', value: () => { const d = shiftDay(kzToday(), -1); return [d, d] } },
  { text: '7 дней', value: () => [shiftDay(kzToday(), -6), kzToday()] },
  { text: 'Этот месяц', value: () => [kzToday().slice(0, 8) + '01', kzToday()] },
  { text: 'Прошлый месяц', value: () => { const e = shiftDay(kzToday().slice(0, 8) + '01', -1); return [e.slice(0, 8) + '01', e] } },
]

function params(extra: Record<string, unknown> = {}) {
  return {
    docType: f.value.docType || journal.value?.join(',') || undefined, status: f.value.status || undefined,
    from: f.value.range?.[0], to: f.value.range?.[1], search: f.value.search || undefined,
    counterpartyId: f.value.counterpartyId || undefined, storeId: f.value.storeId || undefined, productId: f.value.productId || undefined,
    sort: sort.value || undefined, page: page.value, limit: limit.value, ...extra,
  }
}

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  error.value = ''
  const p = params()
  router.replace({ query: { docType: f.value.docType || undefined, status: p.status, from: p.from, to: p.to, search: p.search, counterpartyId: p.counterpartyId, storeId: p.storeId, productId: p.productId, sort: sort.value !== 'date_desc' ? sort.value : undefined, page: page.value > 1 ? String(page.value) : undefined } })
  try {
    const res = (await api.get('/accounting/trade-documents', { params: p })) as any
    if (my !== seq) return
    items.value = res.items
    total.value = res.total
    sum.value = res.sum ?? '0'
  } catch (e: any) {
    if (my === seq) error.value = e?.message || 'Не удалось загрузить документы'
  } finally {
    if (my === seq) loading.value = false
  }
}
function reload() { if (page.value !== 1) page.value = 1; else load() } // смена страницы сама вызывает load (watch)

let timer: ReturnType<typeof setTimeout> | undefined
function onSearch() { clearTimeout(timer); timer = setTimeout(reload, 350) }

function clearFilters() {
  f.value = { docType: '', status: '', search: '', range: null, counterpartyId: '', storeId: '', productId: '' }
  reload()
}

async function fetchAll() {
  const all: any[] = []
  for (let p = 1; p <= 50; p++) {
    const res = (await api.get('/accounting/trade-documents', { params: params({ page: p, limit: 200 }) })) as any
    all.push(...res.items)
    if (all.length >= res.total || !res.items.length) break
  }
  return all
}

function create(type: string) { router.push({ path: '/accounting/trade/new', query: { type } }) }

// ── справочники фильтров ──
const cps = ref<any[]>([]), cpLoading = ref(false)
async function findCp(s: string) {
  cpLoading.value = true
  try { cps.value = ((await api.get('/catalog/counterparties', { params: { search: s || undefined, limit: 20 } })) as any).items ?? [] } catch { cps.value = [] } finally { cpLoading.value = false }
}
const products = ref<any[]>([]), prLoading = ref(false)
async function findProduct(s: string) {
  prLoading.value = true
  try { products.value = ((await api.get('/catalog/items', { params: { search: s || undefined, limit: 20 } })) as any).items ?? [] } catch { products.value = [] } finally { prLoading.value = false }
}
const stores = ref<any[]>([])

async function loadIssues() {
  try { issuesCount.value = ((await api.get('/accounting/autopilot/status')) as any).openIssues || 0 } catch { issuesCount.value = 0 }
}

watch([page, limit, sort], () => load())

onMounted(async () => {
  load()
  loadIssues()
  try { stores.value = (await api.get('/catalog/warehouses')) as any[] } catch { /* без складов */ }
  // подписи выбранных фильтров из адреса
  if (f.value.counterpartyId) try { cps.value = [await api.get(`/catalog/counterparties/${f.value.counterpartyId}`)] } catch { /* нет доступа */ }
  if (f.value.productId) try { products.value = [await api.get(`/catalog/items/${f.value.productId}`)] } catch { /* нет доступа */ }
})
</script>

<style scoped>
.w-search { width: 260px; }
.w-range { width: 250px !important; flex: 0 0 auto; }
.w-type { width: 200px; }
.w-status { width: 150px; }
.w-cp { width: 230px; }
.w-store { width: 180px; }
.cnt { margin-left: 6px; background: var(--el-color-primary); color: #fff; border-radius: 9px; padding: 0 6px; font-size: 11px; }
.num { font-variant-numeric: tabular-nums; }
.money { font-variant-numeric: tabular-nums; font-weight: 500; }
.muted { color: var(--el-text-color-placeholder); }
.pay-part { color: var(--el-color-warning-dark-2); font-weight: 500; font-variant-numeric: tabular-nums; }
.pay-no { color: var(--el-color-danger); font-weight: 500; font-variant-numeric: tabular-nums; }
.ml { margin-left: 4px; }
@media (max-width: 640px) { .w-search, .w-range, .w-type, .w-status, .w-cp, .w-store { width: 100% !important; } }
</style>
