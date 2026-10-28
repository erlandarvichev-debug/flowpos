<template>
  <div>
    <div class="page-header"><h1>Чеки</h1></div>
    <el-card>
      <el-table :data="receipts" v-loading="loading">
        <el-table-column prop="number" label="Номер" width="160" />
        <el-table-column label="Дата/время" width="140">
          <template #default="{ row }">{{ dayjs(row.createdAt).format('DD.MM.YY HH:mm') }}</template>
        </el-table-column>
        <el-table-column label="Тип" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === 'RETURN' ? 'danger' : 'success'" size="small">
              {{ row.type === 'RETURN' ? 'Возврат' : 'Продажа' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Оплата" width="100">
          <template #default="{ row }">
            <el-tag size="small" type="info">{{ payLabels[row.paymentType] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Сумма" width="140" align="right">
          <template #default="{ row }">{{ formatMoney(row.totalAmount) }}</template>
        </el-table-column>
        <el-table-column label="Статус" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'COMPLETED' ? 'success' : row.status === 'CANCELLED' ? 'danger' : 'info'" size="small">
              {{ statusLabels[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        style="margin-top: 16px;"
        v-model:current-page="page"
        :page-size="50"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="load"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import dayjs from 'dayjs'
import api from '@/api/client'

const loading = ref(false)
const receipts = ref<any[]>([])
const total = ref(0)
const page = ref(1)

const payLabels: Record<string, string> = { CASH: 'Нал.', CARD: 'Карта', MIXED: 'Смеш.', QR: 'QR' }
const statusLabels: Record<string, string> = { PENDING: 'В процессе', COMPLETED: 'Завершён', CANCELLED: 'Отменён' }

function formatMoney(v: number) {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(v)
}

async function load() {
  loading.value = true
  const res = await api.get('/pos/receipts', { params: { page: page.value } }) as any
  receipts.value = res.items ?? res.data ?? []
  total.value = res.total ?? 0
  loading.value = false
}

onMounted(load)
</script>
