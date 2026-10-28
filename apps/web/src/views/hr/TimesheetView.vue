<template>
  <div>
    <div class="page-header">
      <h1>Табель учёта рабочего времени</h1>
      <div style="display: flex; gap: 12px; align-items: center;">
        <el-select v-model="month" @change="load" style="width: 130px;">
          <el-option v-for="m in months" :key="m.value" :label="m.label" :value="m.value" />
        </el-select>
        <el-select v-model="year" @change="load" style="width: 90px;">
          <el-option v-for="y in years" :key="y" :label="y" :value="y" />
        </el-select>
        <el-button type="primary" @click="calculate" :loading="calculating">Рассчитать</el-button>
        <el-tag :type="timesheet?.status === 'APPROVED' ? 'success' : 'info'">
          {{ statusLabels[timesheet?.status] || '...' }}
        </el-tag>
      </div>
    </div>

    <el-card v-loading="loading">
      <el-table :data="rows">
        <el-table-column label="Сотрудник" min-width="200">
          <template #default="{ row }">
            {{ getEmployee(row.employeeId) }}
          </template>
        </el-table-column>
        <el-table-column prop="daysWorked" label="Дней" width="80" align="right" />
        <el-table-column prop="hoursWorked" label="Часов" width="80" align="right" />
        <el-table-column prop="sickDays" label="Больн." width="80" align="right" />
        <el-table-column prop="vacationDays" label="Отпуск" width="80" align="right" />
        <el-table-column prop="absenceDays" label="Прогул" width="80" align="right" />
      </el-table>
      <el-empty v-if="!rows.length" description="Нет данных. Нажмите «Рассчитать»." />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import 'dayjs/locale/ru'
import api from '@/api/client'

dayjs.locale('ru')

const loading = ref(false)
const calculating = ref(false)
const timesheet = ref<any>(null)
const rows = ref<any[]>([])
const employees = ref<any[]>([])
const month = ref(dayjs().month() + 1)
const year = ref(dayjs().year())

const months = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: dayjs().month(i).format('MMMM'),
}))
const years = [dayjs().year() - 1, dayjs().year(), dayjs().year() + 1]

const statusLabels: Record<string, string> = {
  DRAFT: 'Черновик', APPROVED: 'Утверждён', SENT_TO_1C: 'В 1С',
}

function getEmployee(id: string) {
  const e = employees.value.find(e => e.id === id)
  return e ? `${e.lastName} ${e.firstName}` : id
}

async function load() {
  loading.value = true
  timesheet.value = await api.get('/hr/timesheet', { params: { month: month.value, year: year.value } }) as any
  rows.value = timesheet.value?.rows || []
  loading.value = false
}

async function calculate() {
  calculating.value = true
  try {
    timesheet.value = await api.post('/hr/timesheet/calculate', { month: month.value, year: year.value }) as any
    rows.value = timesheet.value?.rows || []
    ElMessage.success('Табель рассчитан')
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  calculating.value = false
}

onMounted(async () => {
  const res = await api.get('/hr/employees', { params: { limit: 200 } }) as any
  employees.value = res.employees
  await load()
})
</script>
