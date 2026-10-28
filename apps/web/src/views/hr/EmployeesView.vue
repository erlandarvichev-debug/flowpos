<template>
  <div>
    <div class="page-header">
      <h1>Сотрудники</h1>
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить</el-button>
    </div>
    <el-card>
      <el-input v-model="search" placeholder="Поиск..." clearable @input="debouncedLoad" style="width: 300px; margin-bottom: 16px;" :prefix-icon="Search" />
      <el-table :data="employees" v-loading="loading">
        <el-table-column label="ФИО" min-width="200">
          <template #default="{ row }">{{ row.lastName }} {{ row.firstName }} {{ row.middleName }}</template>
        </el-table-column>
        <el-table-column prop="position" label="Должность" />
        <el-table-column prop="department" label="Отдел" />
        <el-table-column label="Тип" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="empTypeColor[row.employmentType]">{{ empLabels[row.employmentType] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Статус" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.isActive ? 'success' : 'danger'">
              {{ row.isActive ? 'Активен' : 'Уволен' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="" width="100">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" @click="openForm(row)" />
            <el-button size="small" text @click="markCheckIn(row)">→</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="editItem ? 'Редактировать' : 'Новый сотрудник'" width="560px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="Фамилия"><el-input v-model="form.lastName" /></el-form-item>
        <el-form-item label="Имя"><el-input v-model="form.firstName" /></el-form-item>
        <el-form-item label="Отчество"><el-input v-model="form.middleName" /></el-form-item>
        <el-form-item label="Должность"><el-input v-model="form.position" /></el-form-item>
        <el-form-item label="Отдел"><el-input v-model="form.department" /></el-form-item>
        <el-form-item label="Тип занятости">
          <el-select v-model="form.employmentType">
            <el-option label="Полная занятость" value="FULL_TIME" />
            <el-option label="Частичная" value="PART_TIME" />
            <el-option label="Подрядчик" value="CONTRACTOR" />
            <el-option label="Самозанятый" value="SELF_EMPLOYED" />
          </el-select>
        </el-form-item>
        <el-form-item label="Оклад">
          <el-input-number v-model="form.salary" :min="0" style="width: 180px;" />
        </el-form-item>
        <el-form-item label="Дата приёма">
          <el-date-picker v-model="form.hireDate" type="date" format="DD.MM.YYYY" value-format="YYYY-MM-DD" />
        </el-form-item>
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
const employees = ref<any[]>([])
const search = ref('')
const formVisible = ref(false)
const editItem = ref<any>(null)
const form = ref<any>({})

const empLabels: Record<string, string> = {
  FULL_TIME: 'Штат', PART_TIME: 'Частичная', CONTRACTOR: 'Подрядчик', SELF_EMPLOYED: 'Самозанятый',
}
const empTypeColor: Record<string, string> = {
  FULL_TIME: 'success', PART_TIME: 'primary', CONTRACTOR: 'warning', SELF_EMPLOYED: 'info',
}

let timer: ReturnType<typeof setTimeout>
function debouncedLoad() { clearTimeout(timer); timer = setTimeout(load, 400) }

async function load() {
  loading.value = true
  const res = await api.get('/hr/employees', { params: { search: search.value || undefined } }) as any
  employees.value = res.employees
  loading.value = false
}

function openForm(item?: any) {
  editItem.value = item || null
  form.value = item
    ? { lastName: item.lastName, firstName: item.firstName, middleName: item.middleName, position: item.position, department: item.department, employmentType: item.employmentType, salary: item.salary, hireDate: item.hireDate }
    : { lastName: '', firstName: '', middleName: '', position: '', department: '', employmentType: 'FULL_TIME', salary: 0, hireDate: null }
  formVisible.value = true
}

async function markCheckIn(emp: any) {
  await api.post(`/hr/employees/${emp.id}/check-in`)
  ElMessage.success(`Отметка ПРИХОД: ${emp.lastName} ${emp.firstName}`)
}

async function save() {
  saving.value = true
  try {
    if (editItem.value) {
      await api.put(`/hr/employees/${editItem.value.id}`, form.value)
    } else {
      await api.post('/hr/employees', form.value)
    }
    ElMessage.success('Сохранено')
    formVisible.value = false
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  saving.value = false
}

onMounted(load)
</script>
