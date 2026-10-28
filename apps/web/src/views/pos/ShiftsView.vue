<template>
  <div>
    <div class="page-header">
      <h1>Кассовые смены</h1>
      <el-select v-model="terminalId" placeholder="Все кассы" clearable @change="load" style="width: 200px;">
        <el-option v-for="t in terminals" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
    </div>
    <el-card>
      <el-table :data="shifts" v-loading="loading">
        <el-table-column prop="number" label="Номер" width="130" />
        <el-table-column prop="terminal.name" label="Касса" />
        <el-table-column label="Открыта" width="140">
          <template #default="{ row }">{{ dayjs(row.openedAt).format('DD.MM.YY HH:mm') }}</template>
        </el-table-column>
        <el-table-column label="Закрыта" width="140">
          <template #default="{ row }">{{ row.closedAt ? dayjs(row.closedAt).format('DD.MM.YY HH:mm') : '—' }}</template>
        </el-table-column>
        <el-table-column label="Статус" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'OPEN' ? 'success' : 'info'" size="small">
              {{ row.status === 'OPEN' ? 'Открыта' : 'Закрыта' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Продажи" width="140" align="right">
          <template #default="{ row }">{{ formatMoney(row.totalSales) }}</template>
        </el-table-column>
        <el-table-column label="" width="80">
          <template #default="{ row }">
            <el-button v-if="row.status === 'OPEN'" size="small" type="danger" text @click="closeShift(row)">
              Закрыть
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'

const loading = ref(false)
const shifts = ref<any[]>([])
const terminals = ref<any[]>([])
const terminalId = ref('')

function formatMoney(v: number) {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(v)
}

async function load() {
  loading.value = true
  const res = await api.get('/pos/shifts', { params: { terminalId: terminalId.value || undefined } }) as any
  shifts.value = res.items ?? res.data ?? []
  loading.value = false
}

async function closeShift(s: any) {
  try {
    await api.put(`/pos/shifts/${s.id}/close`)
    ElMessage.success('Смена закрыта')
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
}

onMounted(async () => {
  terminals.value = await api.get('/pos/terminals') as any[]
  await load()
})
</script>
