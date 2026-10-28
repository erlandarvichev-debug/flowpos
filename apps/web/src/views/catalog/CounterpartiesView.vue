<template>
  <div>
    <div class="page-header">
      <h1>Контрагенты</h1>
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить</el-button>
    </div>

    <el-card>
      <el-row :gutter="12" style="margin-bottom: 16px;">
        <el-col :span="10">
          <el-input v-model="search" placeholder="Поиск по названию, ИНН, телефону..." :prefix-icon="Search" clearable @input="debouncedLoad" />
        </el-col>
        <el-col :span="6">
          <el-select v-model="typeFilter" placeholder="Тип" clearable @change="loadList">
            <el-option label="Покупатели" value="CUSTOMER" />
            <el-option label="Поставщики" value="SUPPLIER" />
            <el-option label="Оба" value="BOTH" />
          </el-select>
        </el-col>
      </el-row>

      <el-table :data="list" v-loading="loading">
        <el-table-column prop="name" label="Наименование" min-width="200" />
        <el-table-column label="Тип" width="120">
          <template #default="{ row }">
            <el-tag :type="row.type === 'CUSTOMER' ? 'success' : row.type === 'SUPPLIER' ? 'warning' : 'info'" size="small">
              {{ typeLabels[row.type] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="inn" label="ИНН" width="140" />
        <el-table-column prop="phone" label="Телефон" />
        <el-table-column prop="email" label="Email" />
        <el-table-column label="" width="80">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click="openForm(row)" />
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        style="margin-top: 16px;"
        v-model:current-page="page"
        :page-size="50"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="loadList"
      />
    </el-card>

    <el-dialog v-model="formVisible" :title="editItem ? 'Редактировать' : 'Новый контрагент'" width="560px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="Название" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Тип">
          <el-select v-model="form.type">
            <el-option label="Покупатель" value="CUSTOMER" />
            <el-option label="Поставщик" value="SUPPLIER" />
            <el-option label="Оба" value="BOTH" />
          </el-select>
        </el-form-item>
        <el-form-item label="ИНН"><el-input v-model="form.inn" /></el-form-item>
        <el-form-item label="Телефон"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="Email"><el-input v-model="form.email" /></el-form-item>
        <el-form-item label="Адрес"><el-input v-model="form.address" /></el-form-item>
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
import { Plus, Search, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'

const loading = ref(false)
const saving = ref(false)
const list = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const search = ref('')
const typeFilter = ref('')
const formVisible = ref(false)
const editItem = ref<any>(null)
const form = ref<any>({})
const typeLabels: Record<string, string> = { CUSTOMER: 'Покупатель', SUPPLIER: 'Поставщик', BOTH: 'Оба' }

let debounceTimer: ReturnType<typeof setTimeout>
function debouncedLoad() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { page.value = 1; loadList() }, 400)
}

async function loadList() {
  loading.value = true
  const res = await api.get('/catalog/counterparties', {
    params: { search: search.value || undefined, type: typeFilter.value || undefined, page: page.value },
  }) as any
  list.value = res.items ?? res.counterparties ?? res.data ?? []
  total.value = res.total ?? 0
  loading.value = false
}

function openForm(item?: any) {
  editItem.value = item || null
  form.value = item
    ? { name: item.name, type: item.type, inn: item.inn, phone: item.phone, email: item.email, address: item.address }
    : { name: '', type: 'CUSTOMER', inn: '', phone: '', email: '', address: '' }
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    if (editItem.value) {
      await api.put(`/catalog/counterparties/${editItem.value.id}`, form.value)
      ElMessage.success('Обновлено')
    } else {
      await api.post('/catalog/counterparties', form.value)
      ElMessage.success('Создано')
    }
    formVisible.value = false
    loadList()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  saving.value = false
}

onMounted(loadList)
</script>
