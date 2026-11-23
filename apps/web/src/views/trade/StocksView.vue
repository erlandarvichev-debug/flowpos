<template>
  <div class="stocks">
    <div class="page-header">
      <div>
        <h1>Остатки</h1>
        <div class="sub">Сколько товара на складах: факт, резерв под заказы, свободно и что едет от поставщиков</div>
      </div>
      <div class="actions">
        <el-button :icon="Download" :loading="exporting" @click="exportCsv">Скачать</el-button>
        <el-button v-if="data.belowMin" type="warning" plain @click="router.push('/accounting/purchase-needs')">Пополнить ({{ data.belowMin }})</el-button>
      </div>
    </div>

    <el-card shadow="never">
      <div class="bar">
        <el-input v-model="search" placeholder="Название, код, артикул или штрихкод" :prefix-icon="Search" clearable class="search" @input="onSearch" @clear="reload" />
        <el-select v-model="storeId" placeholder="Все склады" clearable class="store" @change="reload">
          <el-option v-for="w in stores" :key="w.id" :label="w.name" :value="w.id" />
        </el-select>
        <el-radio-group v-model="filter" @change="reload">
          <el-radio-button value="">С остатком</el-radio-button>
          <el-radio-button value="below">Ниже минимума<span v-if="data.belowMin" class="cnt">{{ data.belowMin }}</span></el-radio-button>
          <el-radio-button value="reserved">В резерве</el-radio-button>
          <el-radio-button value="negative">Минус</el-radio-button>
          <el-radio-button value="all">Все</el-radio-button>
        </el-radio-group>
      </div>

      <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="err">
        <el-button size="small" @click="load">Повторить</el-button>
      </el-alert>

      <el-table :data="data.items" v-loading="loading" stripe :default-sort="sortDefault" @sort-change="onSort" @row-click="openItem" row-class-name="clickable" empty-text=" ">
        <el-table-column prop="name" label="Товар" min-width="260" sortable="custom">
          <template #default="{ row }">
            <div class="name">{{ row.name }}</div>
            <div class="meta"><span v-if="row.code">код {{ row.code }}</span><span v-if="row.article">арт. {{ row.article }}</span></div>
          </template>
        </el-table-column>
        <el-table-column prop="store" label="Склад" min-width="150" sortable="custom">
          <template #default="{ row }">{{ row.store }}<el-tag v-if="row.inTransit" size="small" type="info" class="ml">в пути</el-tag></template>
        </el-table-column>
        <el-table-column prop="qty" label="Остаток" width="130" align="right" sortable="custom">
          <template #default="{ row }"><b :class="{ neg: num(row.qty) < 0 }">{{ fmtQty(row.qty) }}</b> <span class="uom">{{ row.uom }}</span></template>
        </el-table-column>
        <el-table-column label="Резерв" width="110" align="right">
          <template #default="{ row }"><span :class="{ muted: !num(row.reserved) }">{{ fmtQty(row.reserved) }}</span></template>
        </el-table-column>
        <el-table-column label="Свободно" width="120" align="right">
          <template #default="{ row }"><b :class="{ neg: num(row.free) < 0, low: row.below }">{{ fmtQty(row.free) }}</b></template>
        </el-table-column>
        <el-table-column label="Ожидается" width="120" align="right">
          <template #default="{ row }"><span :class="num(row.onOrder) ? 'inc' : 'muted'">{{ num(row.onOrder) ? '+' + fmtQty(row.onOrder) : '—' }}</span></template>
        </el-table-column>
        <el-table-column label="Мин. / пополнять до" width="160" align="right">
          <template #default="{ row }">
            <template v-if="row.minQty !== null">
              <el-tag v-if="row.below" size="small" type="warning" effect="light" class="mr">мало</el-tag>{{ fmtQty(row.minQty) }} / {{ fmtQty(row.maxQty) }}
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && !error && !data.items.length" :description="emptyText" :image-size="80" />

      <div class="foot" v-if="data.total > 0">
        <span class="muted">Позиций: {{ data.total }}</span>
        <el-pagination v-model:current-page="page" v-model:page-size="limit" :page-sizes="[25, 50, 100, 200]" :total="data.total"
          layout="sizes, prev, pager, next" background small @current-change="load" @size-change="reload" />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Download, Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import { downloadCsv } from '@/utils/csv'

interface Row { productId: string; storeId: string; code: string | null; article: string | null; name: string; uom: string | null; store: string; inTransit: boolean; qty: string; reserved: string; free: string; onOrder: string; minQty: string | null; maxQty: string | null; below: boolean }

const route = useRoute()
const router = useRouter()
const stores = ref<any[]>([])
const data = ref<{ items: Row[]; total: number; belowMin: number }>({ items: [], total: 0, belowMin: 0 })
const loading = ref(false)
const exporting = ref(false)
const error = ref('')
const search = ref(String(route.query.search ?? ''))
const storeId = ref<string>(String(route.query.storeId ?? '') || '')
const filter = ref(String(route.query.filter ?? ''))
const sort = ref('')
const page = ref(1)
const limit = ref(50)
const sortDefault = computed(() => ({}))

const num = (v: string | null | undefined) => Number(v ?? 0)
const fmtQty = (v: string | null | undefined) => (v === null || v === undefined ? '—' : num(v).toLocaleString('ru-RU', { maximumFractionDigits: 3 }))
const emptyText = computed(() => search.value ? 'Ничего не найдено' : filter.value === 'below' ? 'Все товары выше точки заказа' : 'Остатков нет')

function params(extra: Record<string, unknown> = {}) {
  return { search: search.value || undefined, storeId: storeId.value || undefined, filter: filter.value || undefined, sort: sort.value || undefined, page: page.value, limit: limit.value, ...extra }
}

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  error.value = ''
  router.replace({ query: { ...route.query, search: search.value || undefined, storeId: storeId.value || undefined, filter: filter.value || undefined } })
  try {
    const res = (await api.get('/accounting/stock-balance', { params: params() })) as any
    if (my === seq) data.value = res
  } catch (e: any) {
    if (my === seq) error.value = e?.message || 'Не удалось загрузить остатки'
  } finally {
    if (my === seq) loading.value = false
  }
}
function reload() { page.value = 1; load() }

let t: ReturnType<typeof setTimeout> | undefined
function onSearch() { clearTimeout(t); t = setTimeout(reload, 350) }

function onSort({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) {
  sort.value = !order ? '' : prop === 'qty' ? (order === 'ascending' ? 'qty_asc' : 'qty_desc') : prop === 'store' ? 'store' : ''
  reload()
}

function openItem(row: Row) { router.push(`/catalog/items/${row.productId}`) }

async function exportCsv() {
  exporting.value = true
  try {
    const all: Row[] = []
    for (let p = 1; p <= 50; p++) {
      const res = (await api.get('/accounting/stock-balance', { params: params({ page: p, limit: 200 }) })) as any
      all.push(...res.items)
      if (all.length >= res.total || !res.items.length) break
    }
    downloadCsv(`остатки-${new Date().toISOString().slice(0, 10)}`,
      ['Код', 'Артикул', 'Товар', 'Ед.', 'Склад', 'Остаток', 'Резерв', 'Свободно', 'Ожидается', 'Точка заказа', 'Пополнять до'],
      all.map((r) => [r.code, r.article, r.name, r.uom, r.store, r.qty, r.reserved, r.free, r.onOrder, r.minQty, r.maxQty]))
  } catch (e: any) {
    ElMessage.error(e?.message || 'Не удалось выгрузить')
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  load()
  try { stores.value = ((await api.get('/catalog/warehouses')) as any[]).filter((w) => !w.deleted) } catch { /* без списка складов — фильтр пустой */ }
})
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 4px; }
.actions { display: flex; gap: 8px; }
.bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
.search { width: 320px; max-width: 100%; }
.store { width: 220px; }
.cnt { margin-left: 6px; background: var(--el-color-warning); color: #fff; border-radius: 9px; padding: 0 6px; font-size: 11px; }
.err { margin-bottom: 12px; }
.name { font-weight: 500; }
.meta { font-size: 12px; color: var(--el-text-color-secondary); display: flex; gap: 10px; }
.uom { color: var(--el-text-color-secondary); font-size: 12px; }
.neg { color: var(--el-color-danger); }
.low { color: var(--el-color-warning-dark-2); }
.inc { color: var(--el-color-success); }
.muted { color: var(--el-text-color-placeholder); }
.ml { margin-left: 6px; }
.mr { margin-right: 6px; }
.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; flex-wrap: wrap; gap: 8px; }
:deep(.clickable) { cursor: pointer; }
@media (max-width: 640px) { .search, .store { width: 100%; } }
</style>
