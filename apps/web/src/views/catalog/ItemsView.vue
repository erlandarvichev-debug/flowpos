<template>
  <div>
    <PageHeader title="Номенклатура" subtitle="Товары и услуги: цены, остатки, штрихкоды">
      <el-dropdown trigger="click" @command="(c: string) => (c === 'weight' ? openWeight() : openDuplicates())">
        <el-button>Ещё<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="weight">Весовые штрихкоды</el-dropdown-item>
            <el-dropdown-item command="dups">Дубли штрихкодов</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить товар</el-button>
    </PageHeader>

    <el-card shadow="never">
      <DataTable
        ref="tableRef" :columns="columns" :rows="items" :loading="loading" :error="error" :total="total" v-model:page="page" v-model:limit="limit" v-model:sort="sort"
        storage-key="items" clickable :selectable="canManage" export-name="номенклатура" :fetch-all="fetchAll" :unit="['позиция', 'позиции', 'позиций']"
        :empty-text="search || groupId || kind || archived ? 'Ничего не найдено' : 'Товаров пока нет — добавьте первый'"
        @row-click="openDetail" @retry="loadItems"
      >
        <template #filters>
          <el-input v-model="search" placeholder="Название, код, артикул или штрихкод" clearable :prefix-icon="Search" class="w-search" @input="debouncedLoad" @clear="reload" />
          <el-select v-model="groupId" placeholder="Группа" clearable filterable class="w-group" @change="reload">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
          <el-select v-model="kind" placeholder="Вид" clearable class="w-kind" @change="reload">
            <el-option label="Товары" value="PRODUCT" /><el-option label="Услуги" value="SERVICE" /><el-option label="Комплекты" value="BUNDLE" />
          </el-select>
          <el-checkbox v-model="archived" border @change="reload">Архив</el-checkbox>
        </template>
        <template #bulk="{ rows }">
          <template v-if="!archived">
            <el-dropdown trigger="click" @command="(g: string) => bulk(rows, 'group', { groupId: g === '-' ? null : g })">
              <el-button size="small">В группу<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="-">Без группы</el-dropdown-item>
                  <el-dropdown-item v-for="g in groups" :key="g.id" :command="g.id">{{ g.name }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-dropdown trigger="click" @command="(v: string) => bulk(rows, 'vat', { vatRate: v === '-' ? null : Number(v) })">
              <el-button size="small">НДС<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="16">16%</el-dropdown-item><el-dropdown-item command="0">0%</el-dropdown-item><el-dropdown-item command="-">Без НДС</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button size="small" type="danger" plain @click="bulk(rows, 'archive')">В архив</el-button>
          </template>
          <el-button v-else size="small" type="primary" plain @click="bulk(rows, 'restore')">Вернуть из архива</el-button>
        </template>
        <template #cell-name="{ row }">
          <span class="name">{{ row.name }}</span>
          <el-tag v-if="row._count?.variants" size="small" effect="plain" class="ml">вариантов: {{ row._count.variants }}</el-tag>
          <el-tag v-if="row.kind === 'SERVICE'" size="small" type="info" effect="plain" class="ml">услуга</el-tag>
          <el-tag v-if="row.kind === 'BUNDLE'" size="small" type="info" effect="plain" class="ml">комплект</el-tag>
          <el-tag v-if="row.plu" size="small" type="warning" effect="plain" class="ml">весовой {{ row.plu }}</el-tag>
        </template>
        <template #cell-stock="{ row }">
          <span v-if="row.kind === 'SERVICE'" class="muted">—</span>
          <span v-else :class="{ neg: Number(row.stockQty) < 0, muted: !Number(row.stockQty) }">{{ row.stockQty === null ? '0' : fmtQty(row.stockQty) }}</span>
        </template>
        <template #cell-price="{ row }">{{ getRetailPrice(row) }}</template>
        <template #actions="{ row }">
          <el-button v-if="canManage" size="small" text :icon="Edit" aria-label="Изменить" @click="openForm(row)" />
        </template>
      </DataTable>
    </el-card>

    <el-dialog v-model="formVisible" :title="editItem ? 'Редактировать' : 'Новый товар'" width="560px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="Код">
          <el-input v-model="form.code" />
        </el-form-item>
        <el-form-item label="Наименование" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="Единица">
          <el-select v-model="form.uomId" placeholder="Выберите ед. изм.">
            <el-option v-for="u in units" :key="u.id" :label="u.name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Группа">
          <el-select v-model="form.groupId" placeholder="Группа" clearable>
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.kind !== 'VARIANT'" label="Вид">
          <el-select v-model="form.kind">
            <el-option label="Товар" value="PRODUCT" />
            <el-option label="Услуга" value="SERVICE" />
            <el-option label="Комплект" value="BUNDLE" />
          </el-select>
        </el-form-item>
        <el-form-item label="Артикул">
          <el-input v-model="form.article" />
        </el-form-item>
        <el-form-item label="НДС %">
          <el-input-number v-model="form.vatRate" :min="0" :max="100" />
        </el-form-item>
        <el-form-item label="PLU весового">
          <el-input v-model="form.plu" :placeholder="`${weight.pluLength} цифр — код товара на весах`" clearable />
        </el-form-item>
        <el-form-item v-if="!editItem" label="Штрихкод">
          <el-input v-model="form.barcode" placeholder="Отсканируйте или введите" clearable />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="saveItem" :loading="saving">Сохранить</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="weightVisible" title="Весовые штрихкоды" width="520px">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;"
        title="Этикетка весов (EAN-13): префикс 20–29, код товара (PLU), вес в граммах, контрольная цифра. Префиксы и длину PLU возьмите из настроек весов." />
      <el-form label-width="160px">
        <el-form-item label="Префиксы">
          <el-select v-model="weightForm.prefixes" multiple placeholder="Выключено">
            <el-option v-for="p in PREFIXES" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="Длина PLU">
          <el-input-number v-model="weightForm.pluLength" :min="4" :max="6" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="weightVisible = false">Отмена</el-button>
        <el-button type="primary" :loading="saving" @click="saveWeight">Сохранить</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="dupVisible" title="Дубли штрихкодов" width="720px">
      <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 12px;"
        title="Код из обмена с МойСклад уже принадлежит другому товару — у этого товара на кассе он не найдётся. Уберите код у одного из товаров (в учётной системе-источнике)." />
      <el-table :data="dups" size="small" empty-text="Дублей нет">
        <el-table-column prop="barcode" label="Штрихкод" width="150" />
        <el-table-column label="Товар с кодом в карточке"><template #default="{ row }"><el-link @click="router.push(`/catalog/items/${row.productId}`)">{{ row.productName }}</el-link></template></el-table-column>
        <el-table-column label="На кассе находится"><template #default="{ row }"><el-link @click="router.push(`/catalog/items/${row.ownerId}`)">{{ row.ownerName }}</el-link></template></el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowDown, Plus, Search, Edit } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import PageHeader from '@/components/ui/PageHeader.vue'
import DataTable, { type Col } from '@/components/ui/DataTable.vue'
import { fmtQty } from '@/utils/format'
import { useOrgStore } from '@/stores/org'

const router = useRouter()
const loading = ref(false)
const saving = ref(false)
const items = ref<any[]>([])
const groups = ref<any[]>([])
const units = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const limit = ref(50)
const sort = ref('name_asc')
const search = ref('')
const groupId = ref('')
const kind = ref('')
const archived = ref(false)
const error = ref('')
const tableRef = ref<any>()
const org = useOrgStore()
const canManage = computed(() => org.can('catalog.manage'))
const columns = computed<Col[]>(() => [
  { key: 'code', label: 'Код', width: 110, sortable: true },
  { key: 'name', label: 'Наименование', minWidth: 260, sortable: true, required: true, export: (r) => r.name },
  { key: 'article', label: 'Артикул', width: 130, hidden: true },
  { key: 'uom', label: 'Ед.', width: 70, value: (r) => r.uom?.shortName },
  { key: 'group', label: 'Группа', minWidth: 150, ellipsis: true, value: (r) => r.group?.name },
  { key: 'stock', label: 'Остаток', width: 110, align: 'right', export: (r) => r.stockQty ?? '0' },
  { key: 'price', label: 'Цена сегодня, ₸', width: 140, align: 'right', export: (r) => prices.value[r.id] ?? '' },
  { key: 'vatRate', label: 'НДС %', width: 90, align: 'right', hidden: true, value: (r) => (r.vatRate === null ? 'без НДС' : Number(r.vatRate)) },
  { key: 'barcode', label: 'Штрихкод', width: 150, hidden: true, value: (r) => r.barcodes?.[0]?.barcode },
])
const formVisible = ref(false)
const editItem = ref<any>(null)
const form = ref<any>({})

let debounceTimer: ReturnType<typeof setTimeout>
function debouncedLoad() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(reload, 350)
}
function reload() { tableRef.value?.clearSelection(); if (page.value !== 1) page.value = 1; else loadItems() }
watch([page, limit, sort], () => loadItems())
const params = (extra: Record<string, unknown> = {}) => ({ search: search.value || undefined, groupId: groupId.value || undefined, kind: kind.value || undefined, archived: archived.value ? '1' : undefined, sort: sort.value || undefined, page: page.value, limit: limit.value, ...extra })
async function fetchAll() {
  const all: any[] = []
  for (let p = 1; p <= 50; p++) {
    const res = (await api.get('/catalog/items', { params: params({ page: p, limit: 200 }) })) as any
    all.push(...res.items)
    if (all.length >= res.total || !res.items.length) break
  }
  return all
}
async function bulk(rows: any[], action: string, extra: Record<string, unknown> = {}) {
  if (action === 'archive') {
    try {
      await ElMessageBox.confirm(`Убрать в архив ${rows.length} поз.? В документах и на кассе они перестанут предлагаться; вернуть можно из архива.`, 'В архив', { type: 'warning', confirmButtonText: 'В архив', cancelButtonText: 'Отмена' })
    } catch { return }
  }
  try {
    const r = (await api.post('/catalog/items/bulk', { ids: rows.map((x) => x.id), action, ...extra })) as any
    ElMessage.success(`Изменено: ${r.updated}`)
    tableRef.value?.clearSelection()
    loadItems()
  } catch (e) { showError(e) }
}

async function loadItems() {
  loading.value = true
  try {
    error.value = ''
    const res = (await api.get('/catalog/items', { params: params() })) as any
    items.value = res.items
    total.value = res.total
    loadPrices(res.items)
  } catch (e: any) {
    error.value = e?.message || 'Не удалось загрузить товары'
  } finally {
    loading.value = false
  }
}

// Цена — по действующим прайс-листам на сегодня (как в заказе и на кассе), а не из старой таблицы цен.
const prices = ref<Record<string, number | null>>({})
async function loadPrices(list: any[]) {
  const ids = list.map((i) => i.id)
  if (!ids.length) return
  try {
    const res = (await api.post('/pricing/preview', { lines: ids.map((id) => ({ productId: id, qty: 1 })) })) as any
    const map: Record<string, number | null> = {}
    ;(res.lines ?? []).forEach((l: any, i: number) => { map[ids[i]] = l.basePrice === null || l.basePrice === undefined ? null : Number(l.basePrice) })
    prices.value = map
  } catch { prices.value = {} }
}

async function loadMeta() {
  try {
    const [g, u, w] = await Promise.all([
      api.get('/catalog/items/groups'),
      api.get('/catalog/items/units'),
      api.get('/catalog/items/settings'),
    ]) as any[]
    groups.value = g
    units.value = u
    weight.value = w
  } catch (e: any) {
    ElMessage.error(e?.message || 'Не удалось загрузить справочники')
  }
}

function getRetailPrice(item: any) {
  const p = prices.value[item.id]
  if (p === null || p === undefined) return '—'
  return p.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₸'
}

// FP-025: форма — в полях API (uomId, kind); НДС по умолчанию — ставка НК РК 2026 (16%).
function openForm(item?: any) {
  editItem.value = item || null
  form.value = item
    ? { code: item.code, name: item.name, article: item.article, uomId: item.uomId, groupId: item.groupId, kind: item.kind, vatRate: item.vatRate == null ? null : Number(item.vatRate), plu: item.plu }
    : { code: '', name: '', article: '', uomId: units.value[0]?.id, kind: 'PRODUCT', vatRate: 16, plu: '', barcode: '' }
  formVisible.value = true
}

const PREFIXES = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29']
const weight = ref<{ prefixes: string[]; pluLength: number }>({ prefixes: [], pluLength: 5 })
const weightVisible = ref(false)
const weightForm = ref<{ prefixes: string[]; pluLength: number }>({ prefixes: [], pluLength: 5 })
function openWeight() {
  weightForm.value = { ...weight.value, prefixes: [...weight.value.prefixes] }
  weightVisible.value = true
}
async function saveWeight() {
  saving.value = true
  try {
    weight.value = await api.put('/catalog/items/settings', weightForm.value) as any
    weightVisible.value = false
    ElMessage.success('Настройки весовых штрихкодов сохранены')
  } catch (e) { showError(e) }
  saving.value = false
}
const dupVisible = ref(false)
const dups = ref<any[]>([])
async function openDuplicates() {
  try { dups.value = await api.get('/catalog/items/barcode-duplicates') as any; dupVisible.value = true } catch (e) { showError(e) }
}

function openDetail(row: any) {
  router.push(`/catalog/items/${row.id}`)
}

async function saveItem() {
  saving.value = true
  try {
    const { barcode, ...body } = form.value
    if (editItem.value) {
      await api.put(`/catalog/items/${editItem.value.id}`, body)
      ElMessage.success('Товар обновлён')
    } else {
      await api.post('/catalog/items', { ...body, barcodes: barcode ? [{ barcode }] : undefined })
      ElMessage.success('Товар создан')
    }
    formVisible.value = false
    loadItems()
  } catch (e) {
    showError(e)
  }
  saving.value = false
}

onMounted(() => {
  loadMeta()
  loadItems()
})
</script>

<style scoped>
.w-search { width: 300px; }
.w-group { width: 200px; }
.w-kind { width: 140px; }
.name { font-weight: 500; }
.ml { margin-left: 6px; }
.neg { color: var(--el-color-danger); font-weight: 500; }
.muted { color: var(--el-text-color-placeholder); }
@media (max-width: 640px) { .w-search, .w-group, .w-kind { width: 100%; } }
</style>
