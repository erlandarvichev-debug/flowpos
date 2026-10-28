<template>
  <div>
    <div class="page-header">
      <h1>Аналитика</h1>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        format="DD.MM.YYYY"
        value-format="YYYY-MM-DD"
        @change="load"
      />
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="Продажи" name="sales">
        <el-row :gutter="16" v-loading="loading">
          <el-col :span="12">
            <el-card>
              <template #header><b>Продажи по дням</b></template>
              <v-chart :option="salesChartOption" style="height: 300px;" />
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card>
              <template #header><b>Топ товаров по выручке</b></template>
              <v-chart :option="topItemsChartOption" style="height: 300px;" />
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <el-tab-pane label="Остатки" name="stocks">
        <el-card v-loading="stocksLoading">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <b>Остатки товаров</b>
              <el-select v-model="warehouseId" placeholder="Все склады" clearable @change="loadStocks" style="width: 200px;">
                <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
              </el-select>
            </div>
          </template>
          <el-table :data="stocks" size="small">
            <el-table-column prop="item.code" label="Код" width="100" />
            <el-table-column prop="item.name" label="Товар" min-width="220" />
            <el-table-column prop="warehouse.name" label="Склад" />
            <el-table-column label="Остаток" width="100" align="right">
              <template #default="{ row }">
                <b :style="{ color: row.quantity < 5 ? '#f56c6c' : 'inherit' }">{{ row.quantity }}</b>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="Персонал" name="hr">
        <el-row :gutter="16">
          <el-col :span="6" v-for="kpi in hrKpis" :key="kpi.label">
            <div class="stat-card">
              <div class="stat-value">{{ kpi.value }}</div>
              <div class="stat-label">{{ kpi.label }}</div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { use } from 'echarts/core'
import { BarChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import dayjs from 'dayjs'
import api from '@/api/client'

use([BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const loading = ref(false)
const stocksLoading = ref(false)
const activeTab = ref('sales')
const dateRange = ref([
  dayjs().startOf('month').format('YYYY-MM-DD'),
  dayjs().format('YYYY-MM-DD'),
])
const dashData = ref<any>({})
const hrData = ref<any>({})
const stocks = ref<any[]>([])
const warehouses = ref<any[]>([])
const warehouseId = ref('')

const salesChartOption = computed(() => {
  const data = dashData.value?.salesByDay || []
  return {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.map((d: any) => d.date) },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: data.map((d: any) => d.amount), itemStyle: { color: '#409eff' } }],
  }
})

const topItemsChartOption = computed(() => {
  const items = dashData.value?.topItems || []
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      data: items.map((i: any) => ({ name: i.item?.name?.substring(0, 20), value: i.totalAmount })),
    }],
  }
})

const hrKpis = computed(() => [
  { label: 'Сотрудников', value: hrData.value?.totalEmployees || 0 },
  { label: 'Явка %', value: `${hrData.value?.attendanceRate || 0}%` },
  { label: 'Смен выполнено', value: hrData.value?.shiftsCompleted || 0 },
  { label: 'Ср. часов', value: hrData.value?.avgHoursPerEmployee || 0 },
])

async function load() {
  loading.value = true
  const [dash, hr] = await Promise.all([
    api.get(`/analytics/dashboard?from=${dateRange.value[0]}&to=${dateRange.value[1]}`),
    api.get(`/analytics/hr-dashboard?from=${dateRange.value[0]}&to=${dateRange.value[1]}`),
  ]) as any[]
  dashData.value = dash
  hrData.value = hr
  loading.value = false
}

async function loadStocks() {
  stocksLoading.value = true
  stocks.value = await api.get('/analytics/stocks', {
    params: { warehouseId: warehouseId.value || undefined },
  }) as any[]
  stocksLoading.value = false
}

onMounted(async () => {
  warehouses.value = await api.get('/catalog/warehouses') as any[]
  await Promise.all([load(), loadStocks()])
})
</script>
