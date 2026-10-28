<template>
  <div>
    <div class="page-header">
      <h1>Остатки товаров</h1>
      <el-select v-model="warehouseId" placeholder="Все склады" clearable @change="load" style="width: 220px;">
        <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
      </el-select>
    </div>
    <el-card>
      <el-input v-model="search" placeholder="Поиск..." :prefix-icon="Search" clearable @input="filterLocal" style="width: 320px; margin-bottom: 16px;" />
      <el-table :data="filtered" v-loading="loading">
        <el-table-column prop="item.code" label="Код" width="100" />
        <el-table-column prop="item.name" label="Наименование" min-width="220" />
        <el-table-column prop="item.unit.shortName" label="Ед." width="60" />
        <el-table-column prop="warehouse.name" label="Склад" />
        <el-table-column label="Остаток" width="120" align="right">
          <template #default="{ row }">
            <b :style="{ color: row.quantity < 5 ? '#f56c6c' : '#303133' }">{{ row.quantity }}</b>
          </template>
        </el-table-column>
        <el-table-column label="Резерв" width="100" align="right">
          <template #default="{ row }">
            <el-text type="warning">{{ row.reserved || 0 }}</el-text>
          </template>
        </el-table-column>
        <el-table-column label="Доступно" width="110" align="right">
          <template #default="{ row }">
            {{ (row.quantity - (row.reserved || 0)).toFixed(2) }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Search } from '@element-plus/icons-vue'
import api from '@/api/client'

const loading = ref(false)
const stocks = ref<any[]>([])
const warehouses = ref<any[]>([])
const warehouseId = ref('')
const search = ref('')

const filtered = computed(() => {
  if (!search.value) return stocks.value
  const q = search.value.toLowerCase()
  return stocks.value.filter(s =>
    s.item?.name?.toLowerCase().includes(q) || s.item?.code?.toLowerCase().includes(q)
  )
})

function filterLocal() {}

async function load() {
  loading.value = true
  stocks.value = await api.get('/trade/stocks', {
    params: { warehouseId: warehouseId.value || undefined },
  }) as any[]
  loading.value = false
}

onMounted(async () => {
  warehouses.value = await api.get('/catalog/warehouses') as any[]
  await load()
})
</script>
