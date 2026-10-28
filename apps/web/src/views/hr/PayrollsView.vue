<template>
  <div>
    <div class="page-header">
      <h1>Расчёт заработной платы</h1>
      <el-button type="primary" :icon="Plus" @click="formVisible = true">Начислить</el-button>
    </div>

    <el-card>
      <el-row :gutter="12" style="margin-bottom: 16px;">
        <el-col :span="5">
          <el-select v-model="filterMonth" placeholder="Месяц" clearable @change="load">
            <el-option v-for="m in months" :key="m.value" :label="m.label" :value="m.value" />
          </el-select>
        </el-col>
        <el-col :span="4">
          <el-select v-model="filterYear" placeholder="Год" clearable @change="load">
            <el-option v-for="y in years" :key="y" :label="y" :value="y" />
          </el-select>
        </el-col>
      </el-row>

      <el-table :data="payrolls" v-loading="loading">
        <el-table-column label="Сотрудник" min-width="200">
          <template #default="{ row }">{{ row.employee?.lastName }} {{ row.employee?.firstName }}</template>
        </el-table-column>
        <el-table-column label="Период" width="120">
          <template #default="{ row }">{{ monthName(row.month) }} {{ row.year }}</template>
        </el-table-column>
        <el-table-column label="Оклад" width="130" align="right">
          <template #default="{ row }">{{ formatMoney(row.baseSalary) }}</template>
        </el-table-column>
        <el-table-column label="Премии" width="120" align="right">
          <template #default="{ row }">{{ formatMoney(row.bonuses) }}</template>
        </el-table-column>
        <el-table-column label="К выплате" width="140" align="right">
          <template #default="{ row }">
            <b>{{ formatMoney(row.netAmount) }}</b>
          </template>
        </el-table-column>
        <el-table-column label="Статус" width="120">
          <template #default="{ row }">
            <el-tag :type="statusColor[row.status]" size="small">{{ statusLabels[row.status] }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" title="Начислить зарплату" width="480px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="Сотрудник">
          <el-select v-model="form.employeeId" filterable>
            <el-option v-for="e in employees" :key="e.id" :label="`${e.lastName} ${e.firstName}`" :value="e.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Месяц">
          <el-select v-model="form.month">
            <el-option v-for="m in months" :key="m.value" :label="m.label" :value="m.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="Год">
          <el-select v-model="form.year">
            <el-option v-for="y in years" :key="y" :label="y" :value="y" />
          </el-select>
        </el-form-item>
        <el-form-item label="Оклад"><el-input-number v-model="form.baseSalary" :min="0" /></el-form-item>
        <el-form-item label="Премии"><el-input-number v-model="form.bonuses" :min="0" /></el-form-item>
        <el-form-item label="Удержания"><el-input-number v-model="form.deductions" :min="0" /></el-form-item>
        <el-form-item label="ИПН (10%)"><el-input-number v-model="form.taxes" :min="0" /></el-form-item>
        <el-divider />
        <el-form-item label="К выплате">
          <b>{{ formatMoney((form.baseSalary || 0) + (form.bonuses || 0) - (form.deductions || 0) - (form.taxes || 0)) }}</b>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="save" :loading="saving">Начислить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import 'dayjs/locale/ru'
import api from '@/api/client'

dayjs.locale('ru')

const loading = ref(false)
const saving = ref(false)
const payrolls = ref<any[]>([])
const employees = ref<any[]>([])
const formVisible = ref(false)
const filterMonth = ref<number>()
const filterYear = ref<number>()
const form = ref<any>({ month: dayjs().month() + 1, year: dayjs().year(), baseSalary: 0, bonuses: 0, deductions: 0, taxes: 0 })

const months = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: dayjs().month(i).format('MMMM') }))
const years = [dayjs().year() - 1, dayjs().year()]
const statusLabels: Record<string, string> = { DRAFT: 'Черновик', APPROVED: 'Утверждено', PAID: 'Выплачено', SENT_TO_1C: 'В 1С' }
const statusColor: Record<string, string> = { DRAFT: 'info', APPROVED: 'primary', PAID: 'success', SENT_TO_1C: 'warning' }
const monthName = (m: number) => dayjs().month(m - 1).format('MMMM')

function formatMoney(v: number) {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(v)
}

async function load() {
  loading.value = true
  payrolls.value = await api.get('/hr/payrolls', {
    params: { month: filterMonth.value, year: filterYear.value },
  }) as any[]
  loading.value = false
}

async function save() {
  saving.value = true
  const net = (form.value.baseSalary || 0) + (form.value.bonuses || 0) - (form.value.deductions || 0) - (form.value.taxes || 0)
  try {
    await api.post('/hr/payrolls', { ...form.value, netAmount: net })
    ElMessage.success('Начислено')
    formVisible.value = false
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  saving.value = false
}

onMounted(async () => {
  const res = await api.get('/hr/employees', { params: { limit: 200 } }) as any
  employees.value = res.employees
  await load()
})
</script>
