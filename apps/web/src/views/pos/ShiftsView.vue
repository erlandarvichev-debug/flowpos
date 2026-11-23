<template>
  <div>
    <div class="page-header">
      <div>
        <h1>Кассовые смены</h1>
        <div class="sub">Открытые и закрытые смены касс; продажи смены считаются при закрытии</div>
      </div>
      <div class="bar">
        <el-select v-model="terminalId" placeholder="Все кассы" clearable style="width: 200px" @change="reload">
          <el-option v-for="t in terminals" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <el-radio-group v-model="status" @change="reload">
          <el-radio-button value="">Все</el-radio-button>
          <el-radio-button value="OPEN">Открытые</el-radio-button>
          <el-radio-button value="CLOSED">Закрытые</el-radio-button>
        </el-radio-group>
      </div>
    </div>
    <el-card shadow="never">
      <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" style="margin-bottom: 12px" />
      <el-table :data="shifts" v-loading="loading" stripe empty-text=" ">
        <el-table-column prop="number" label="Номер" width="130" />
        <el-table-column label="Касса" min-width="160"><template #default="{ row }">{{ row.terminal?.name || '—' }}</template></el-table-column>
        <el-table-column label="Открыта" width="140"><template #default="{ row }">{{ dayjs(row.openedAt).format('DD.MM.YY HH:mm') }}</template></el-table-column>
        <el-table-column label="Закрыта" width="140"><template #default="{ row }">{{ row.closedAt ? dayjs(row.closedAt).format('DD.MM.YY HH:mm') : '—' }}</template></el-table-column>
        <el-table-column label="Статус" width="110">
          <template #default="{ row }"><el-tag :type="row.status === 'OPEN' ? 'success' : 'info'" size="small">{{ row.status === 'OPEN' ? 'Открыта' : 'Закрыта' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="Начало, ₸" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.openBalance) }}</template></el-table-column>
        <el-table-column label="Внесено / изъято" width="160" align="right">
          <template #default="{ row }"><span class="inc">+{{ fmtMoney(row.cashIn) }}</span> / <span class="dec">−{{ fmtMoney(row.cashOut) }}</span></template>
        </el-table-column>
        <el-table-column label="Продажи, ₸" width="140" align="right"><template #default="{ row }"><b>{{ row.status === 'OPEN' ? '—' : fmtMoney(row.totalSales) }}</b></template></el-table-column>
        <el-table-column width="100" align="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'OPEN'" size="small" type="danger" text @click="closeShift(row)">Закрыть</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !error && !shifts.length" description="Смен пока нет — смену открывают на странице «Кассы»" :image-size="80" />
      <div class="foot" v-if="total > limit">
        <el-pagination v-model:current-page="page" :page-size="limit" :total="total" layout="prev, pager, next" background small @current-change="load" />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'

const route = useRoute()
const loading = ref(false)
const error = ref('')
const shifts = ref<any[]>([])
const terminals = ref<any[]>([])
const terminalId = ref(String(route.query.terminalId ?? ''))
const status = ref('')
const page = ref(1)
const limit = 50
const total = ref(0)

const fmtMoney = (v: unknown) => Number(v ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = (await api.get('/pos/shifts', { params: { terminalId: terminalId.value || undefined, status: status.value || undefined, page: page.value, limit } })) as any
    shifts.value = res.shifts ?? []
    total.value = res.total ?? 0
  } catch (e: any) {
    error.value = e?.message || 'Не удалось загрузить смены'
  } finally {
    loading.value = false
  }
}
function reload() { page.value = 1; load() }

async function closeShift(s: any) {
  try {
    await ElMessageBox.confirm(`Закрыть смену ${s.number} на кассе «${s.terminal?.name ?? ''}»?`, 'Закрытие смены', { type: 'warning', confirmButtonText: 'Закрыть', cancelButtonText: 'Отмена' })
  } catch { return }
  try {
    await api.put(`/pos/shifts/${s.id}/close`)
    ElMessage.success('Смена закрыта')
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Не удалось закрыть смену') }
}

onMounted(async () => {
  load()
  try { terminals.value = (await api.get('/pos/terminals')) as any[] } catch { /* фильтр без списка касс */ }
})
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 4px; }
.bar { display: flex; gap: 12px; flex-wrap: wrap; }
.inc { color: var(--el-color-success); }
.dec { color: var(--el-color-danger); }
.foot { display: flex; justify-content: flex-end; margin-top: 16px; }
</style>
