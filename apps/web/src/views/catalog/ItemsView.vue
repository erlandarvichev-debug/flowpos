<template>
  <div>
    <div class="page-header">
      <h1>Номенклатура</h1>
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить товар</el-button>
    </div>

    <el-card>
      <el-row :gutter="12" style="margin-bottom: 16px;">
        <el-col :span="10">
          <el-input v-model="search" placeholder="Поиск по названию или коду..." clearable @input="debouncedLoad" :prefix-icon="Search" />
        </el-col>
        <el-col :span="6">
          <el-select v-model="groupId" placeholder="Группа" clearable @change="loadItems">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
        </el-col>
      </el-row>

      <el-table :data="items" v-loading="loading" row-key="id" @row-click="openDetail">
        <el-table-column prop="code" label="Код" width="100" />
        <el-table-column prop="name" label="Наименование" min-width="240" />
        <el-table-column prop="unit.shortName" label="Ед." width="60" />
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
          <el-select v-model="form.unitId" placeholder="Выберите ед. изм.">
            <el-option v-for="u in units" :key="u.id" :label="u.name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Группа">
          <el-select v-model="form.groupId" placeholder="Группа" clearable>
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Тип товара">
          <el-select v-model="form.itemType">
            <el-option label="Товар" value="PRODUCT" />
            <el-option label="Услуга" value="SERVICE" />
            <el-option label="Комплект" value="KIT" />
          </el-select>
        </el-form-item>
        <el-form-item label="НДС %">
          <el-input-number v-model="form.vatRate" :min="0" :max="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="saveItem" :loading="saving">Сохранить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Plus, Search, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
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
  const [g, u] = await Promise.all([
    api.get('/catalog/items/groups'),
    api.get('/catalog/items/units'),
  ]) as any[]
  groups.value = g
  units.value = u
}

function getRetailPrice(item: any) {
  const p = item.prices?.find((pr: any) => pr.priceType?.isDefault)
  if (!p) return '—'
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(p.price)
}

function openForm(item?: any) {
  editItem.value = item || null
  form.value = item
    ? { code: item.code, name: item.name, unitId: item.unitId, groupId: item.groupId, itemType: item.itemType, vatRate: item.vatRate }
    : { code: '', name: '', unitId: units.value[0]?.id, itemType: 'PRODUCT', vatRate: 12 }
  formVisible.value = true
}

function openDetail(row: any) {
  router.push(`/catalog/items/${row.id}`)
}

async function saveItem() {
  saving.value = true
  try {
    if (editItem.value) {
      await api.put(`/catalog/items/${editItem.value.id}`, form.value)
      ElMessage.success('Товар обновлён')
    } else {
      await api.post('/catalog/items', form.value)
      ElMessage.success('Товар создан')
    }
    formVisible.value = false
    loadItems()
  } catch (err: any) {
    ElMessage.error(err?.message || 'Ошибка')
  }
  saving.value = false
}

onMounted(() => {
  loadMeta()
  loadItems()
})
</script>
