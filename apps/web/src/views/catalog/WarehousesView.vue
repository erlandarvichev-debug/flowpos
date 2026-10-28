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
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <b>Остатки: {{ selected.name }}</b>
          <el-input v-model="stockSearch" placeholder="Поиск..." clearable style="width: 240px;" @input="loadStocks" />
        </div>
      </template>
      <el-table :data="stocks" v-loading="stocksLoading">
        <el-table-column prop="item.code" label="Код" width="100" />
        <el-table-column prop="item.name" label="Товар" min-width="200" />
        <el-table-column prop="item.unit.shortName" label="Ед." width="60" />
        <el-table-column label="Остаток" width="120" align="right">
          <template #default="{ row }">
            <b :style="{ color: row.quantity < 5 ? '#f56c6c' : 'inherit' }">{{ row.quantity }}</b>
          </template>
        </el-table-column>
        <el-table-column label="Резерв" width="100" align="right">
          <template #default="{ row }">
            <el-text type="warning">{{ row.reserved || 0 }}</el-text>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

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

async function loadWarehouses() {
  loading.value = true
  warehouses.value = await api.get('/catalog/warehouses') as any[]
  loading.value = false
}

async function selectWarehouse(w: any) {
  selected.value = w
  await loadStocks()
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
</style>
