<template>
  <div>
    <div class="page-header">
      <h1>Инвентаризации</h1>
      <el-button type="primary" :icon="Plus">Создать инвентаризацию</el-button>
    </div>
    <el-card>
      <el-table :data="inventories" v-loading="loading">
        <el-table-column prop="number" label="Номер" width="140" />
        <el-table-column label="Дата" width="110">
          <template #default="{ row }">{{ dayjs(row.date).format('DD.MM.YYYY') }}</template>
        </el-table-column>
        <el-table-column prop="comment" label="Комментарий" />
        <el-table-column label="Статус" width="140">
          <template #default="{ row }">
            <el-tag :type="statusType[row.status]" size="small">{{ statusLabels[row.status] }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import dayjs from 'dayjs'
import api from '@/api/client'

const loading = ref(false)
const inventories = ref<any[]>([])
const statusLabels: Record<string, string> = {
  DRAFT: 'Черновик', IN_PROGRESS: 'Выполняется', POSTED: 'Проведена', CANCELLED: 'Отменена',
}
const statusType: Record<string, string> = {
  DRAFT: 'info', IN_PROGRESS: 'warning', POSTED: 'success', CANCELLED: 'danger',
}

onMounted(async () => {
  loading.value = true
  const res = await api.get('/trade/inventories') as any
  inventories.value = res.items
  loading.value = false
})
</script>
