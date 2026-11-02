<template>
  <div>
    <div class="page-header">
      <h1>Склады</h1>
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить склад</el-button>
    </div>

    <el-row :gutter="16" v-loading="loading">
      <el-col :span="8" v-for="w in warehouses" :key="w.id">
        <el-card class="warehouse-card" @click="selectWarehouse(w)" :class="{ selected: selected?.id === w.id }">
          <div style="display: flex; align-items: center; gap: 12px;">
            <el-icon :size="32" :color="w.isRetail ? '#e6a23c' : '#409eff'">
              <component :is="w.isRetail ? 'ShoppingCart' : 'House'" />
            </el-icon>
            <div>
              <div style="font-weight: 600; font-size: 16px;">{{ w.name }}</div>
              <el-text type="info" size="small">{{ w.code }}</el-text>
              <el-tag v-if="w.isRetail" size="small" type="warning" style="margin-left: 8px;">Розница</el-tag>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card style="margin-top: 16px;" v-if="selected">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
          <b>{{ selected.name }}</b>
          <el-input v-if="tab === 'STOCK'" v-model="stockSearch" placeholder="Поиск..." clearable style="width: 240px;" @input="loadStocks" />
          <el-button v-else type="primary" size="small" :icon="Plus" @click="openBin()">Добавить ячейку</el-button>
        </div>
      </template>
      <el-tabs v-model="tab">
        <el-tab-pane label="Остатки" name="STOCK">
          <el-table :data="stocks" v-loading="stocksLoading" empty-text="Остатков нет">
            <el-table-column label="Код" width="110"><template #default="{ row }">{{ row.product?.code }}</template></el-table-column>
            <el-table-column label="Товар" min-width="200"><template #default="{ row }">{{ row.product?.name }}</template></el-table-column>
            <el-table-column label="Ячейка" width="140"><template #default="{ row }">{{ row.bin ? (row.bin.code || row.bin.name) : '—' }}</template></el-table-column>
            <el-table-column label="Ед." width="60"><template #default="{ row }">{{ row.product?.uom?.shortName }}</template></el-table-column>
            <el-table-column label="Остаток" width="110" align="right"><template #default="{ row }"><b>{{ Number(row.qty) }}</b></template></el-table-column>
            <el-table-column label="Резерв" width="100" align="right"><template #default="{ row }"><el-text type="warning">{{ Number(row.reserved) || '' }}</el-text></template></el-table-column>
          </el-table>
          <div class="hint">Свободно = остаток − резерв (резерв ставится заказом покупателя и учитывается по складу в целом).</div>
        </el-tab-pane>
        <el-tab-pane :label="`Ячейки (${(selected.bins || []).length})`" name="BINS">
          <el-table :data="selected.bins || []" empty-text="Ячеек нет — товар хранится на складе без адреса">
            <el-table-column prop="code" label="Код" width="120" />
            <el-table-column prop="name" label="Название" min-width="200" />
            <el-table-column label="Ряд / секция / ярус" width="200"><template #default="{ row }">{{ [row.row, row.section, row.level].filter(Boolean).join(' / ') }}</template></el-table-column>
            <el-table-column label="" width="190">
              <template #default="{ row }">
                <el-tag size="small" :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? 'используется' : 'выключена' }}</el-tag>
                <el-button link type="primary" size="small" @click="openBin(row)">Изменить</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="binVisible" :title="bin.id ? 'Ячейка' : 'Новая ячейка'" width="440px">
      <el-form label-width="130px">
        <el-form-item label="Название" required><el-input v-model="bin.name" placeholder="Стеллаж A, полка 1" /></el-form-item>
        <el-form-item label="Код"><el-input v-model="bin.code" placeholder="A-1" /></el-form-item>
        <el-form-item label="Ряд"><el-input v-model="bin.row" /></el-form-item>
        <el-form-item label="Секция"><el-input v-model="bin.section" /></el-form-item>
        <el-form-item label="Ярус"><el-input v-model="bin.level" /></el-form-item>
        <el-form-item v-if="bin.id" label="Используется"><el-switch v-model="bin.isActive" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="binVisible = false">Отмена</el-button>
        <el-button type="primary" @click="saveBin" :loading="saving">Сохранить</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="formVisible" title="Новый склад" width="440px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="Название" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Код"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="Адрес"><el-input v-model="form.address" /></el-form-item>
        <el-form-item label="Розничный"><el-switch v-model="form.isRetail" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="save" :loading="saving">Сохранить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'

const loading = ref(false)
const stocksLoading = ref(false)
const warehouses = ref<any[]>([])
const stocks = ref<any[]>([])
const selected = ref<any>(null)
const stockSearch = ref('')
const formVisible = ref(false)
const saving = ref(false)
const form = ref<any>({ name: '', code: '', isRetail: false })
const tab = ref('STOCK')
const binVisible = ref(false)
const bin = ref<any>({})

async function loadWarehouses() {
  loading.value = true
  warehouses.value = await api.get('/catalog/warehouses') as any[]
  loading.value = false
}

async function selectWarehouse(w: any) {
  selected.value = await api.get(`/catalog/warehouses/${w.id}`)
  await loadStocks()
}

function openBin(b?: any) {
  bin.value = b ? { ...b } : { name: '', code: '', row: '', section: '', level: '' }
  binVisible.value = true
}

async function saveBin() {
  saving.value = true
  try {
    const { id, name, code, row, section, level, isActive } = bin.value
    const body = { name, code, row, section, level, ...(id ? { isActive } : {}) }
    await (id ? api.put(`/catalog/warehouses/${selected.value.id}/bins/${id}`, body) : api.post(`/catalog/warehouses/${selected.value.id}/bins`, body))
    ElMessage.success('Ячейка сохранена')
    binVisible.value = false
    selected.value = await api.get(`/catalog/warehouses/${selected.value.id}`)
  } catch (e: any) {
    ElMessage.error(e?.message || 'Ошибка')
  }
  saving.value = false
}

async function loadStocks() {
  if (!selected.value) return
  stocksLoading.value = true
  const res = await api.get(`/catalog/warehouses/${selected.value.id}/stocks`, {
    params: { search: stockSearch.value || undefined },
  }) as any
  stocks.value = res.stocks
  stocksLoading.value = false
}

function openForm() {
  form.value = { name: '', code: '', isRetail: false }
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    await api.post('/catalog/warehouses', form.value)
    ElMessage.success('Склад создан')
    formVisible.value = false
    await loadWarehouses()
  } catch (e: any) {
    ElMessage.error(e?.message || 'Ошибка')
  }
  saving.value = false
}

onMounted(loadWarehouses)
</script>

<style scoped>
.warehouse-card {
  cursor: pointer;
  margin-bottom: 16px;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.warehouse-card:hover { box-shadow: 0 4px 16px rgba(64,158,255,0.15); }
.warehouse-card.selected { border-color: #409eff; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 6px; }
</style>
