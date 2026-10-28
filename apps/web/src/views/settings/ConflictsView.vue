<template>
  <div>
    <div class="page-header">
      <h1>Конфликты синхронизации</h1>
      <el-tag type="danger" v-if="total > 0">{{ total }} конфликт(ов)</el-tag>
    </div>

    <el-card>
      <el-table :data="rows" v-loading="loading" style="width: 100%;">
        <el-table-column prop="entity" label="Тип" width="130" />
        <el-table-column prop="id" label="ID" width="240" />
        <el-table-column prop="number" label="Номер" width="130" />
        <el-table-column label="Статус" width="120">
          <template #default="{ row }">
            <el-tag type="danger" size="small">Конфликт</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Обновлено" width="160">
          <template #default="{ row }">
            {{ row.updatedAt ? dayjs(row.updatedAt).format('DD.MM.YY HH:mm') : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="Действия" width="220">
          <template #default="{ row }">
            <el-button
              size="small"
              type="primary"
              :loading="resolvingId === row.id"
              @click="resolve(row, 'keep_local')"
            >Оставить нашу</el-button>
            <el-button
              size="small"
              type="warning"
              :loading="resolvingId === row.id"
              @click="resolve(row, 'take_1c')"
            >Взять из 1С</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="!rows.length && !loading" style="text-align: center; padding: 32px; color: #999;">
        <el-icon :size="40"><CircleCheck /></el-icon>
        <div style="margin-top: 8px;">Конфликтов нет</div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { CircleCheck } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'

const rows = ref<any[]>([])
const loading = ref(false)
const resolvingId = ref<string | null>(null)
const total = ref(0)

async function load() {
  loading.value = true
  try {
    const res = await api.get('/sync/conflicts')
    rows.value = res.data ?? []
    total.value = rows.value.length
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

async function resolve(row: any, resolution: 'keep_local' | 'take_1c') {
  resolvingId.value = row.id
  try {
    await api.post(`/sync/conflicts/${row.id}/resolve`, { resolution })
    ElMessage.success(resolution === 'keep_local' ? 'Оставили нашу версию' : 'Применена версия из 1С')
    rows.value = rows.value.filter((r) => r.id !== row.id)
    total.value--
  } catch {
    ElMessage.error('Не удалось разрешить конфликт')
  } finally {
    resolvingId.value = null
  }
}

onMounted(load)
</script>
