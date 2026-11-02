<template>
  <!-- Расчёт зарплаты за месяц (законы РК 2026): отработанные дни, налоги и взносы, утверждение с проводками,
       расчётные листки и ведомость, выплата (черновики платёжных поручений). -->
  <div>
    <div class="page-header">
      <h1>Расчёт зарплаты</h1>
      <div class="actions">
        <el-date-picker v-model="period" type="month" value-format="YYYY-MM" :clearable="false" style="width: 150px;" @change="load" />
        <el-tag :type="TAG[p.status]">{{ STATUS[p.status] }}</el-tag>
        <template v-if="org.can('payroll.approve')">
          <el-button v-if="p.status !== 'CLOSED'" type="primary" :loading="busy" @click="calc">{{ p.status === 'NONE' ? 'Рассчитать' : 'Пересчитать' }}</el-button>
          <el-button v-if="p.status === 'CALCULATED'" type="success" :loading="busy" @click="approve">Утвердить</el-button>
          <el-button v-if="p.status === 'CLOSED'" @click="unapprove">Отменить утверждение</el-button>
        </template>
        <PrintButton v-if="p.status !== 'NONE'" source="PAYROLL" :id="period" />
      </div>
    </div>

    <template v-if="p.status !== 'NONE'">
      <div class="totals">
        <div class="total"><div class="label">Начислено</div><div class="value">{{ fmtMoney(t.gross) }}</div></div>
        <div class="total"><div class="label">Удержано (ОПВ, ВОСМС, ИПН)</div><div class="value">{{ fmtMoney(sumOf(t.opv, t.vosms, t.ipn)) }}</div></div>
        <div class="total main"><div class="label">К выплате</div><div class="value">{{ fmtMoney(t.net) }}</div></div>
        <div class="total"><div class="label">За счёт работодателя (СО, ООСМС, ОПВР, СН)</div><div class="value">{{ fmtMoney(sumOf(t.so, t.oosms, t.opvr, t.sn)) }}</div></div>
      </div>
      <el-alert v-if="p.status === 'CALCULATED'" type="info" :closable="false" show-icon class="block" :title="`Норма месяца: ${p.totals?.normDays ?? '—'} рабочих дней. Измените отработанные дни у сотрудника и нажмите «Пересчитать».`" />
    </template>
    <el-empty v-else description="Зарплата за месяц не рассчитывалась — нажмите «Рассчитать»" />

    <el-table v-if="p.results.length" :data="p.results" size="small" show-summary :summary-method="summary">
      <el-table-column label="Сотрудник" min-width="200" fixed><template #default="{ row }"><b>{{ row.name }}</b><div class="muted">{{ row.contractNumber }}</div></template></el-table-column>
      <el-table-column label="Дни" width="110" align="center">
        <template #default="{ row }">
          <el-input-number v-if="p.status === 'CALCULATED' && org.can('payroll.approve')" v-model="days[row.contractId]" :min="0" :max="row.normDays" size="small" controls-position="right" style="width: 90px;" />
          <span v-else>{{ Number(row.workedDays) }} / {{ row.normDays }}</span>
        </template>
      </el-table-column>
      <el-table-column v-for="c in COLS" :key="c.k" :label="c.l" :prop="c.k" :width="c.w ?? 110" align="right"><template #default="{ row }"><span :class="{ b: c.b }">{{ fmtMoney(row[c.k]) }}</span></template></el-table-column>
    </el-table>

    <template v-if="p.status === 'CLOSED'">
      <h3>Выплата</h3>
      <el-card shadow="never">
        <div class="pay">
          <el-select v-model="pay.bankAccountId" placeholder="Банковский счёт" style="width: 300px;"><el-option v-for="b in banks" :key="b.value" :value="b.value" :label="b.label" /></el-select>
          <el-date-picker v-model="pay.date" value-format="YYYY-MM-DD" />
          <el-button v-if="org.can('acc.doc.write')" type="primary" :disabled="!pay.bankAccountId" :loading="busy" @click="payout">Создать платёжные поручения</el-button>
        </div>
        <el-table v-if="lines" :data="[{ code: 'SALARY', title: 'Заработная плата', knp: null, total: lines.salary.reduce((s: number, l: any) => s + Number(l.amount), 0).toFixed(2) }, ...lines.obligations]" size="small">
          <el-table-column label="Платёж" prop="title" />
          <el-table-column label="КНП" width="80" prop="knp" />
          <el-table-column label="Сумма" width="160" align="right"><template #default="{ row }">{{ fmtMoney(row.total) }}</template></el-table-column>
        </el-table>
        <p class="muted">Создаются черновики «Списание с расчётного счёта» по каждому виду платежа — проверьте и проведите их в «Банк и касса».</p>
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import PrintButton from '@/components/print/PrintButton.vue'
import { fmtMoney, showError, loadDimOptions } from '../accounting/acc'

const org = useOrgStore()
const d = new Date()
const period = ref(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
const p = ref<any>({ status: 'NONE', results: [] })
const days = ref<Record<string, number>>({})
const busy = ref(false)
const lines = ref<any>(null)
const banks = ref<{ value: string; label: string }[]>([])
const pay = ref({ bankAccountId: '', date: new Date().toISOString().slice(0, 10) })
const STATUS: Record<string, string> = { NONE: 'Не рассчитана', OPEN: 'Открыта', CALCULATED: 'Рассчитана', CLOSED: 'Утверждена' }
const TAG: Record<string, any> = { NONE: 'info', OPEN: 'info', CALCULATED: 'warning', CLOSED: 'success' }
const COLS = [
  { k: 'totalGrossSalary', l: 'Начислено', b: true, w: 120 }, { k: 'opvAmount', l: 'ОПВ' }, { k: 'vosmsAmount', l: 'ВОСМС' }, { k: 'standardDeduction', l: 'Вычет' },
  { k: 'ipnAmount', l: 'ИПН' }, { k: 'otherDeductions', l: 'Прочие удерж.' }, { k: 'netSalaryToPay', l: 'К выплате', b: true, w: 120 },
  { k: 'soAmount', l: 'СО' }, { k: 'oosmsAmount', l: 'ООСМС' }, { k: 'opvrAmount', l: 'ОПВР' }, { k: 'snAmount', l: 'СН' },
]
const t = computed(() => p.value.totals ?? {})
const sumOf = (...xs: any[]) => xs.reduce((s, x) => s + Number(x ?? 0), 0).toFixed(2)
function summary({ columns }: any) {
  return columns.map((c: any, i: number) => (i === 0 ? 'Итого' : COLS.some((x) => x.k === c.property) ? fmtMoney(p.value.results.reduce((s: number, r: any) => s + Number(r[c.property]), 0).toFixed(2)) : ''))
}

async function load() {
  lines.value = null
  try {
    p.value = await api.get(`/accounting/payroll/${period.value}`)
    days.value = Object.fromEntries(p.value.results.map((r: any) => [r.contractId, Number(r.workedDays)]))
    if (p.value.status === 'CLOSED') lines.value = await api.get(`/accounting/payroll/${period.value}/payout`)
  } catch (e) { showError(e) }
}
async function calc() {
  busy.value = true
  try {
    const overrides = Object.fromEntries(p.value.results.filter((r: any) => days.value[r.contractId] !== Number(r.workedDays)).map((r: any) => [r.contractId, { workedDays: days.value[r.contractId] }]))
    const r = (await api.post(`/accounting/payroll/${period.value}/calculate`, { overrides })) as any
    ElMessage.success(`Рассчитано: ${r.results} сотрудников`); await load()
  } catch (e) { showError(e) }
  busy.value = false
}
async function approve() {
  busy.value = true
  try { await api.post(`/accounting/payroll/${period.value}/approve`, {}); ElMessage.success('Зарплата утверждена, проводки сформированы'); await load() } catch (e) { showError(e) }
  busy.value = false
}
async function unapprove() {
  try {
    const { value } = await ElMessageBox.prompt('Причина отмены утверждения', `Отменить утверждение за ${period.value}`, { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })
    await api.post(`/accounting/payroll/${period.value}/unapprove`, { reason: value }); await load()
  } catch (e: any) { if (e !== 'cancel' && e !== 'close') showError(e) }
}
async function payout() {
  busy.value = true
  try { const r = (await api.post(`/accounting/payroll/${period.value}/payout`, pay.value)) as any; ElMessage.success(`Создано платёжных поручений: ${r.documents.length}`) } catch (e) { showError(e) }
  busy.value = false
}
onMounted(async () => { await load(); try { banks.value = await loadDimOptions('BANK_ACCOUNT') } catch { banks.value = [] } })
</script>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; }
.totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 8px 0 16px; }
.total { background: var(--el-fill-color-light); border-radius: 8px; padding: 12px 16px; }
.total.main { background: var(--el-color-primary-light-9); }
.total .label { color: var(--el-text-color-secondary); font-size: 12px; }
.total .value { font-size: 20px; font-weight: 600; margin-top: 4px; }
.block { margin-bottom: 12px; }
.b { font-weight: 600; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
h3 { margin: 20px 0 8px; font-size: 15px; }
.pay { display: flex; gap: 8px; margin-bottom: 12px; }
</style>
