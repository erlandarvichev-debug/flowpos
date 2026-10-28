<template>
  <div>
    <div class="page-header">
      <h1>Дашборд</h1>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        range-separator="-"
        start-placeholder="От"
        end-placeholder="До"
        format="DD.MM.YYYY"
        value-format="YYYY-MM-DD"
        @change="loadDashboard"
      />
    </div>

    <el-row :gutter="16" v-loading="loading">
      <el-col :span="6" v-for="kpi in kpis" :key="kpi.label">
        <div class="stat-card">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <el-icon :size="28" :style="{ color: kpi.color }">
              <component :is="kpi.icon" />
            </el-icon>
          </div>
          <div class="stat-value">{{ kpi.value }}</div>
          <div class="stat-label">{{ kpi.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px;">
      <el-col :span="16">
        <el-card>
          <template #header><b>Продажи по дням</b></template>
          <v-chart
            class="chart"
            :option="salesChartOption"
            style="height: 280px;"
          />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card>
          <template #header><b>Топ товаров</b></template>
          <el-table :data="topItems" size="small" :show-header="false">
            <el-table-column prop="item.name" label="Товар" />
            <el-table-column label="Сумма" width="120" align="right">
              <template #default="{ row }">
                {{ formatMoney(row.totalAmount) }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px;">
      <el-col :span="12">
        <el-card>
          <template #header><b>HR — показатели</b></template>
          <el-row :gutter="16">
            <el-col :span="8">
              <div class="stat-card" style="box-shadow: none; padding: 8px 0;">
                <div class="stat-value" style="font-size: 20px;">{{ hrKpi.totalEmployees }}</div>
                <div class="stat-label">Сотрудников</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="stat-card" style="box-shadow: none; padding: 8px 0;">
                <div class="stat-value" style="font-size: 20px;">{{ hrKpi.attendanceRate }}%</div>
                <div class="stat-label">Явка</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="stat-card" style="box-shadow: none; padding: 8px 0;">
                <div class="stat-value" style="font-size: 20px;">{{ hrKpi.avgHoursPerEmployee }}</div>
                <div class="stat-label">Ср. часов</div>
              </div>
            </el-col>
          </el-row>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <b>Очередь синхронизации 1С</b>
              <el-button size="small" @click="loadSyncStatus">Обновить</el-button>
            </div>
          </template>
          <el-row :gutter="8">
            <el-col :span="6" v-for="s in syncStats" :key="s.label">
              <el-statistic :value="s.value" :title="s.label">
                <template #prefix>
                  <el-icon :style="{ color: s.color }">
                    <component :is="s.icon" />
                  </el-icon>
                </template>
              </el-statistic>
            </el-col>
          </el-row>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { use } from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import api from '@/api/client'
import dayjs from 'dayjs'

use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

const loading = ref(false)
const dateRange = ref([
  dayjs().startOf('month').format('YYYY-MM-DD'),
  dayjs().format('YYYY-MM-DD'),
])

const kpiData = ref<any>({})
const hrKpi = ref<any>({})
const syncStatus = ref<any>({})

const kpis = computed(() => [
  {
    label: 'Продажи',
    value: formatMoney(kpiData.value?.kpi?.totalSalesAmount || 0),
    icon: 'TrendCharts',
    color: '#409eff',
  },
  {
    label: 'Кол-во продаж',
    value: kpiData.value?.kpi?.totalSalesCount || 0,
    icon: 'ShoppingBag',
    color: '#67c23a',
  },
  {
    label: 'Открытых смен',
    value: kpiData.value?.kpi?.activeShifts || 0,
    icon: 'Monitor',
    color: '#e6a23c',
  },
  {
    label: 'Мало остатков',
    value: kpiData.value?.kpi?.lowStockCount || 0,
    icon: 'Warning',
    color: '#f56c6c',
  },
])

const topItems = computed(() => kpiData.value?.topItems || [])

const salesChartOption = computed(() => {
  const data = kpiData.value?.salesByDay || []
  return {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.map((d: any) => d.date), axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v / 1000).toFixed(0)}K` } },
    series: [{
      type: 'bar',
      data: data.map((d: any) => d.amount),
      itemStyle: { color: '#409eff', borderRadius: [4, 4, 0, 0] },
    }],
  }
})

const syncStats = computed(() => [
  { label: 'Ожидает', value: syncStatus.value?.pending || 0, color: '#e6a23c', icon: 'Clock' },
  { label: 'Отправляется', value: syncStatus.value?.sending || 0, color: '#409eff', icon: 'Loading' },
  { label: 'Готово', value: syncStatus.value?.done || 0, color: '#67c23a', icon: 'CircleCheck' },
  { label: 'Ошибки', value: (syncStatus.value?.error || 0) + (syncStatus.value?.dead || 0), color: '#f56c6c', icon: 'CircleClose' },
])

function formatMoney(v: number) {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(v)
}

async function loadDashboard() {
  loading.value = true
  try {
    const [dash, hr] = await Promise.all([
      api.get(`/analytics/dashboard?from=${dateRange.value[0]}&to=${dateRange.value[1]}`),
      api.get(`/analytics/hr-dashboard?from=${dateRange.value[0]}&to=${dateRange.value[1]}`),
    ]) as any[]
    kpiData.value = dash
    hrKpi.value = hr
  } catch {}
  loading.value = false
}

async function loadSyncStatus() {
  try {
    syncStatus.value = await api.get('/sync/outbox/status') as any
  } catch {}
}

onMounted(() => {
  loadDashboard()
  loadSyncStatus()
})
</script>
