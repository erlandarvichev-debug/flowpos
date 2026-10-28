<template>
  <div>
    <div class="page-header">
      <h1>График смен</h1>
      <div style="display: flex; gap: 12px; align-items: center;">
        <el-date-picker v-model="dateRange" type="daterange" format="DD.MM.YYYY" value-format="YYYY-MM-DD" @change="load" />
        <el-button type="primary" :icon="Plus" @click="formVisible = true">Назначить</el-button>
      </div>
    </div>

    <el-card>
      <el-table :data="schedule" v-loading="loading">
        <el-table-column label="Сотрудник" min-width="180">
          <template #default="{ row }">{{ row.employee?.lastName }} {{ row.employee?.firstName }}</template>
        </el-table-column>
        <el-table-column label="Дата" width="110">
          <template #default="{ row }">{{ dayjs(row.date).format('DD.MM.YYYY') }}</template>
        </el-table-column>
        <el-table-column label="Начало" width="90">
          <template #default="{ row }">{{ dayjs(row.startTime).format('HH:mm') }}</template>
        </el-table-column>
        <el-table-column label="Конец" width="90">
          <template #default="{ row }">{{ dayjs(row.endTime).format('HH:mm') }}</template>
        </el-table-column>
        <el-table-column prop="shiftTemplate.name" label="Шаблон" />
        <el-table-column label="Статус" width="130">
          <template #default="{ row }">
            <el-tag :type="statusColor[row.status]" size="small">{{ statusLabels[row.status] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="" width="100">
          <template #default="{ row }">
            <el-select v-model="row._newStatus" size="small" placeholder="Статус" style="width: 90px;" @change="updateStatus(row)">
              <el-option label="Выполнена" value="COMPLETED" />
              <el-option label="Не явился" value="ABSENT" />
              <el-option label="Отмена" value="CANCELLED" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" title="Назначить смену" width="440px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="Сотрудник">
          <el-select v-model="form.employeeId" placeholder="Выберите" filterable>
            <el-option v-for="e in employees" :key="e.id" :label="`${e.lastName} ${e.firstName}`" :value="e.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Дата">
          <el-date-picker v-model="form.date" type="date" format="DD.MM.YYYY" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="Шаблон">
          <el-select v-model="form.shiftTemplateId" placeholder="Шаблон смены" clearable @change="applyTemplate">
            <el-option v-for="t in templates" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Начало">
          <el-time-picker v-model="form.startTime" format="HH:mm" value-format="HH:mm" />
        </el-form-item>
        <el-form-item label="Конец">
          <el-time-picker v-model="form.endTime" format="HH:mm" value-format="HH:mm" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="save" :loading="saving">Назначить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'

const loading = ref(false)
const saving = ref(false)
const schedule = ref<any[]>([])
const employees = ref<any[]>([])
const templates = ref<any[]>([])
const formVisible = ref(false)
const form = ref<any>({})
const dateRange = ref([
  dayjs().startOf('week').format('YYYY-MM-DD'),
  dayjs().endOf('week').format('YYYY-MM-DD'),
])

const statusLabels: Record<string, string> = {
  PLANNED: 'Запланировано', CONFIRMED: 'Подтверждено', IN_PROGRESS: 'В процессе',
  COMPLETED: 'Выполнено', ABSENT: 'Не явился', CANCELLED: 'Отменено',
}
const statusColor: Record<string, string> = {
  PLANNED: 'info', CONFIRMED: 'primary', IN_PROGRESS: 'warning',
  COMPLETED: 'success', ABSENT: 'danger', CANCELLED: 'danger',
}

async function load() {
  loading.value = true
  schedule.value = await api.get('/hr/schedule', {
    params: { from: dateRange.value[0], to: dateRange.value[1] },
  }) as any[]
  loading.value = false
}

function applyTemplate() {
  const t = templates.value.find(t => t.id === form.value.shiftTemplateId)
  if (t) {
    form.value.startTime = t.startTime
    form.value.endTime = t.endTime
  }
}

async function updateStatus(row: any) {
  if (!row._newStatus) return
  await api.put(`/hr/schedule/${row.id}`, { status: row._newStatus })
  ElMessage.success('Статус обновлён')
  row.status = row._newStatus
  row._newStatus = null
}

async function save() {
  saving.value = true
  try {
    const d = form.value.date
    await api.post('/hr/schedule', {
      ...form.value,
      startTime: `${d}T${form.value.startTime}:00`,
      endTime: `${d}T${form.value.endTime}:00`,
    })
    ElMessage.success('Смена назначена')
    formVisible.value = false
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  saving.value = false
}

onMounted(async () => {
  const [emp, tmpl] = await Promise.all([
    api.get('/hr/employees', { params: { limit: 200 } }),
    api.get('/hr/shift-templates'),
  ]) as any[]
  employees.value = emp.employees
  templates.value = tmpl
  await load()
})
</script>
