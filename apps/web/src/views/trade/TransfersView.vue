<template>
  <div>
    <div class="page-header">
      <h1>Перемещения</h1>
      <el-button type="primary" :icon="Plus">Создать перемещение</el-button>
    </div>
    <el-card>
      <el-table :data="transfers" v-loading="loading">
        <el-table-column prop="number" label="Номер" width="140" />
        <el-table-column label="Дата" width="110">
          <template #default="{ row }">{{ dayjs(row.date).format('DD.MM.YYYY') }}</template>
        </el-table-column>
        <el-table-column prop="from.name" label="Откуда" />
        <el-table-column prop="to.name" label="Куда" />
        <el-table-column label="Статус" width="120">
          <template #default="{ row }">
            <el-tag :type="row.status === 'POSTED' ? 'success' : 'info'" size="small">
              {{ row.status === 'POSTED' ? 'Проведено' : 'Черновик' }}
            </el-tag>
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
const transfers = ref<any[]>([])

onMounted(async () => {
  loading.value = true
  const res = await api.get('/trade/transfers') as any
  transfers.value = res.items
  loading.value = false
})
</script>
