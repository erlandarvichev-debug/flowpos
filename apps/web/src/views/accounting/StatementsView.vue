<template>
  <div>
    <div class="page-header">
      <h1>Финансовая отчётность</h1>
      <div class="actions">
        <el-button :disabled="!data" :loading="busy.xlsx" @click="download('xlsx')">Excel</el-button>
        <el-button :disabled="!data" :loading="busy.pdf" @click="download('pdf')">PDF</el-button>
      </div>
    </div>

    <el-card>
      <el-tabs v-model="form" @tab-change="load">
        <el-tab-pane label="Баланс (1-Б)" name="balance" />
        <el-tab-pane label="Прибыли и убытки (2-ОПУ)" name="profit-loss" />
        <el-tab-pane label="Движение денег (3-ДДС, прямой)" name="cash-flow" />
      </el-tabs>
      <div class="filters">
        <el-date-picker v-if="form === 'balance'" v-model="date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 160px;" />
        <el-date-picker v-else v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 260px;" />
        <el-radio-group v-model="unit">
          <el-radio-button value="TENGE">в тенге</el-radio-button>
          <el-radio-button value="THOUSANDS">в тыс. тенге</el-radio-button>
        </el-radio-group>
        <el-button type="primary" :loading="loading" @click="load">Сформировать</el-button>
      </div>

      <template v-if="data">
        <div class="checks">
          <el-tag v-for="c in data.checks" :key="c.message" :type="c.ok ? 'success' : 'danger'" effect="plain" class="check">{{ c.ok ? '✓' : '✗' }} {{ c.message }}</el-tag>
        </div>
        <el-alert v-if="data.unmapped?.length" type="warning" :closable="false" show-icon style="margin-bottom: 8px;"
          :title="`Остатки на счетах вне строк формы: ${data.unmapped.map((u: any) => `${u.code} (${fmtMoney(u.amount)})`).join(', ')}`" />

        <el-table :data="data.lines" size="small" border v-loading="loading" :row-class-name="rowClass">
          <el-table-column label="Наименование показателей" min-width="420">
            <template #default="{ row }"><span :style="{ paddingLeft: `${(row.indent ?? 0) * 18}px` }">{{ row.name }}</span></template>
          </el-table-column>
          <el-table-column label="Код" width="70" align="center"><template #default="{ row }">{{ /^[0-9]/.test(row.code) ? row.code : '' }}</template></el-table-column>
          <el-table-column :label="colCurrent" width="170" align="right"><template #default="{ row }">{{ v(row.current) }}</template></el-table-column>
          <el-table-column :label="colPrevious" width="170" align="right"><template #default="{ row }">{{ v(row.previous) }}</template></el-table-column>
        </el-table>
        <div class="hint">{{ data.source }}. {{ data.note }}</div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import dayjs from 'dayjs'
import api from '@/api/client'
import { fmtMoney, fmtDate, showError } from './acc'

const route = useRoute()
const form = ref<string>((route.query.form as string) || 'balance')
const date = ref(dayjs().endOf('month').format('YYYY-MM-DD'))
const range = ref<[string, string]>([dayjs().startOf('year').format('YYYY-MM-DD'), dayjs().endOf('month').format('YYYY-MM-DD')])
const unit = ref<'TENGE' | 'THOUSANDS'>('TENGE')
const data = ref<any>(null)
const loading = ref(false)
const busy = reactive({ xlsx: false, pdf: false })

const params = () => (form.value === 'balance' ? { date: date.value, unit: unit.value } : { from: range.value[0], to: range.value[1], unit: unit.value })
const colCurrent = computed(() => (!data.value ? '' : form.value === 'balance' ? `На ${fmtDate(data.value.period.to)}` : `${fmtDate(data.value.period.from)} – ${fmtDate(data.value.period.to)}`))
const colPrevious = computed(() => (!data.value ? '' : form.value === 'balance' ? `На ${fmtDate(data.value.period.previousTo)}` : `${fmtDate(data.value.period.previousFrom)} – ${fmtDate(data.value.period.previousTo)}`))
const v = (x: string | null) => (x === null ? '' : unit.value === 'TENGE' ? fmtMoney(x) : new Intl.NumberFormat('ru-KZ').format(Number(x)))
const rowClass = ({ row }: any) => (row.header ? 'row-header' : row.bold ? 'row-total' : '')

async function load() {
  loading.value = true
  try { data.value = await api.get(`/accounting/statements/${form.value}`, { params: params() }) } catch (e) { showError(e) }
  loading.value = false
}

async function download(format: 'xlsx' | 'pdf') {
  busy[format] = true
  try {
    const blob = (await api.get(`/accounting/statements/${form.value}/export`, { params: { ...params(), format }, responseType: 'blob' })) as unknown as Blob
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    const name = { balance: 'balans', 'profit-loss': 'opu', 'cash-flow': 'dds' }[form.value]
    a.download = `${name}_${form.value === 'balance' ? date.value : range.value[1]}.${format}`
    a.click()
    URL.revokeObjectURL(a.href)
  } catch (e) { showError(e) }
  busy[format] = false
}

onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; }
.filters { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
.checks { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.check { white-space: normal; height: auto; line-height: 1.4; padding: 4px 8px; }
.hint { color: #909399; font-size: 12px; margin-top: 8px; line-height: 1.5; }
:deep(.row-header td) { background: #f5f7fa; font-weight: 600; }
:deep(.row-total td) { font-weight: 600; }
</style>
