<template>
  <div>
    <div class="page-header">
      <h1>Номенклатура</h1>
      <div>
        <el-button @click="openWeight">Весовые штрихкоды</el-button>
        <el-button @click="openDuplicates">Дубли штрихкодов</el-button>
        <el-button type="primary" :icon="Plus" @click="openForm()">Добавить товар</el-button>
      </div>
    </div>

    <el-card>
      <el-row :gutter="12" style="margin-bottom: 16px;">
        <el-col :span="10">
          <el-input v-model="search" placeholder="Название, код, артикул или штрихкод..." clearable @input="debouncedLoad" :prefix-icon="Search" />
        </el-col>
        <el-col :span="6">
          <el-select v-model="groupId" placeholder="Группа" clearable @change="loadItems">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
        </el-col>
      </el-row>

      <el-table :data="items" v-loading="loading" row-key="id" @row-click="openDetail">
        <el-table-column prop="code" label="Код" width="100" />
        <el-table-column label="Наименование" min-width="240">
          <template #default="{ row }">
            {{ row.name }}
            <el-tag v-if="row._count?.variants" size="small" effect="plain">вариантов: {{ row._count.variants }}</el-tag>
            <el-tag v-if="row.kind === 'VARIANT'" size="small" type="info" effect="plain">вариант</el-tag>
            <el-tag v-if="row.plu" size="small" type="warning" effect="plain">весовой {{ row.plu }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="uom.shortName" label="Ед." width="60" />
        <el-table-column prop="group.name" label="Группа" />
        <el-table-column label="Цена (розница)" width="130" align="right">
          <template #default="{ row }">
            {{ getRetailPrice(row) }}
          </template>
        </el-table-column>
        <el-table-column label="1С" width="110">
          <template #default="{ row }">
            <SyncStatusBadge :status="row.syncStatus" />
          </template>
        </el-table-column>
        <el-table-column label="" width="50">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click.stop="openForm(row)" />
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        style="margin-top: 16px;"
        v-model:current-page="page"
        :page-size="50"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="loadItems"
      />
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
        title="Код из обмена с 1С/МойСклад уже принадлежит другому товару — у этого товара на кассе он не найдётся. Уберите код у одного из товаров (в учётной системе-источнике)." />
      <el-table :data="dups" size="small" empty-text="Дублей нет">
        <el-table-column prop="barcode" label="Штрихкод" width="150" />
        <el-table-column label="Товар с кодом в карточке"><template #default="{ row }"><el-link @click="router.push(`/catalog/items/${row.productId}`)">{{ row.productName }}</el-link></template></el-table-column>
        <el-table-column label="На кассе находится"><template #default="{ row }"><el-link @click="router.push(`/catalog/items/${row.ownerId}`)">{{ row.ownerName }}</el-link></template></el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Plus, Search, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import SyncStatusBadge from '@/components/SyncStatusBadge.vue'

const router = useRouter()
const loading = ref(false)
const saving = ref(false)
const items = ref<any[]>([])
const groups = ref<any[]>([])
const units = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const search = ref('')
const groupId = ref('')
const formVisible = ref(false)
const editItem = ref<any>(null)
const form = ref<any>({})

let debounceTimer: ReturnType<typeof setTimeout>
function debouncedLoad() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { page.value = 1; loadItems() }, 400)
}

async function loadItems() {
  loading.value = true
  try {
    const res = await api.get('/catalog/items', {
      params: { search: search.value || undefined, groupId: groupId.value || undefined, page: page.value, limit: 50 },
    }) as any
    items.value = res.items
    total.value = res.total
  } catch {}
  loading.value = false
}

async function loadMeta() {
  const [g, u, w] = await Promise.all([
    api.get('/catalog/items/groups'),
    api.get('/catalog/items/units'),
    api.get('/catalog/items/settings'),
  ]) as any[]
  groups.value = g
  units.value = u
  weight.value = w
}

function getRetailPrice(item: any) {
  const p = item.prices?.find((pr: any) => pr.priceType?.isDefault)
  if (!p) return '—'
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(p.price)
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
