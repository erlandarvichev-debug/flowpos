<template>
  <!-- Отпуска и больничные: оформление, утверждение с расчётом среднего заработка (рабочие дни, ТК ст. 114, 133;
       Правила № 908), отмена с причиной; суммы входят в расчёт зарплаты месяца начисления. -->
  <div>
    <div class="page-header">
      <h1>Отпуска и больничные</h1>
      <el-button v-if="org.can('hr.manage')" type="primary" :icon="Plus" @click="openCreate">Оформить</el-button>
    </div>
    <el-card>
      <div class="filters">
        <el-select v-model="f.contractId" clearable filterable placeholder="Сотрудник" style="width: 260px;" @change="load"><el-option v-for="e in staff" :key="e.contractId" :value="e.contractId" :label="e.name" /></el-select>
        <el-segmented v-model="f.status" :options="[{ label: 'Действующие', value: '' }, { label: 'Черновики', value: 'DRAFT' }, { label: 'Отменённые', value: 'CANCELLED' }]" @change="load" />
      </div>
      <el-table :data="items" v-loading="loading" size="small" row-key="id">
        <el-table-column type="expand"><template #default="{ row }"><pre class="calc">{{ explain(row) }}</pre></template></el-table-column>
        <el-table-column label="Сотрудник" min-width="180" prop="name" />
        <el-table-column label="Вид" min-width="220"><template #default="{ row }">{{ row.kindLabel }}<div v-if="row.documentNumber" class="muted">№ {{ row.documentNumber }}</div></template></el-table-column>
        <el-table-column label="Период" width="200"><template #default="{ row }">{{ fmtDate(row.dateFrom) }} — {{ fmtDate(row.dateTo) }}<div class="muted">{{ row.calendarDays }} кал. / {{ row.workDays }} раб.</div></template></el-table-column>
        <el-table-column label="Средний дневной" width="140" align="right"><template #default="{ row }">{{ row.avgDailyWage !== null && Number(row.avgDailyWage) ? fmtMoney(row.avgDailyWage) : '' }}</template></el-table-column>
        <el-table-column label="Сумма" width="140" align="right"><template #default="{ row }"><b>{{ row.amount !== null && Number(row.amount) ? fmtMoney(row.amount) : '' }}</b><div v-if="row.payPeriod" class="muted">в зарплату {{ row.payPeriod }}</div></template></el-table-column>
        <el-table-column label="Состояние" width="130"><template #default="{ row }"><el-tag :type="TAG[row.status]" size="small">{{ STATUS[row.status] }}</el-tag></template></el-table-column>
        <el-table-column label="" width="190">
          <template #default="{ row }">
            <template v-if="org.can('payroll.approve')">
              <el-button v-if="row.status === 'DRAFT'" link type="success" size="small" @click="approve(row)">Утвердить</el-button>
              <el-button v-if="row.status !== 'CANCELLED'" link type="danger" size="small" @click="cancel(row)">{{ row.status === 'DRAFT' ? 'Удалить' : 'Отменить' }}</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
      <p class="muted">Средний дневной = начислено за отработанное время за 12 месяцев / рабочие дни (Правила № 908 п. 8). Отпускные и пособие = средний × рабочие дни события; пособие — не более 25 МРП в месяц (ТК ст. 133). Облагаются как зарплата.</p>
    </el-card>

    <el-dialog v-model="dlg" title="Оформить отсутствие" width="540px">
      <el-form label-width="180px">
        <el-form-item label="Сотрудник"><el-select v-model="n.contractId" filterable style="width: 100%;" @change="loadBalance"><el-option v-for="e in staff.filter((x) => x.status === 'ACTIVE')" :key="e.contractId" :value="e.contractId" :label="e.name" /></el-select></el-form-item>
        <el-form-item label="Вид"><el-select v-model="n.kind" style="width: 100%;"><el-option v-for="(l, k) in KINDS" :key="k" :value="k" :label="l" /></el-select></el-form-item>
        <el-form-item label="С"><el-date-picker v-model="n.dateFrom" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item v-if="n.kind === 'ANNUAL_LEAVE'" label="Календарных дней"><el-input-number v-model="n.days" :min="1" :max="120" /><span class="muted">&nbsp;праздники продлевают отпуск</span></el-form-item>
        <el-form-item v-else label="По"><el-date-picker v-model="n.dateTo" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item v-if="n.kind === 'SICK'" label="№ листа нетрудоспособности"><el-input v-model="n.documentNumber" /></el-form-item>
        <el-form-item label="Примечание"><el-input v-model="n.note" /></el-form-item>
        <el-alert v-if="balance && n.kind === 'ANNUAL_LEAVE'" type="info" :closable="false" :title="`Остаток отпуска: ${balance.balance} дн. (положено ${balance.entitled}, использовано ${balance.used})`" />
      </el-form>
      <template #footer><el-button @click="dlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="create">Сохранить черновик</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, showError } from '../accounting/acc'

const org = useOrgStore()
const KINDS: Record<string, string> = { ANNUAL_LEAVE: 'Ежегодный оплачиваемый отпуск', SICK: 'Временная нетрудоспособность', UNPAID_LEAVE: 'Отпуск без сохранения зарплаты', MATERNITY: 'Отпуск по беременности и родам', OTHER_PAID: 'Прочее с сохранением среднего' }
const STATUS: Record<string, string> = { DRAFT: 'Черновик', APPROVED: 'Утверждено', CANCELLED: 'Отменено' }
const TAG: Record<string, any> = { DRAFT: 'info', APPROVED: 'success', CANCELLED: 'warning' }
const items = ref<any[]>([])
const staff = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const f = ref({ contractId: '', status: '' })
const dlg = ref(false)
const n = ref<any>({})
const balance = ref<any>(null)

function explain(r: any) {
  const c = r.calc
  if (!c) return r.status === 'DRAFT' ? 'Сумма будет рассчитана при утверждении.' : 'Нет данных расчёта.'
  const lines = [c.rule]
  if (c.average) lines.push(`Расчётный период: ${c.average.months.length ? c.average.months.join(', ') : 'нет закрытых месяцев'}; начислено ${c.average.earnings}, рабочих дней ${c.average.days} → средний ${c.average.avgDaily} (${c.average.note})`)
  for (const m of c.byMonth ?? []) lines.push(`${m.period}: ${m.workDays} раб. дн. → ${m.amount}${m.capped ? ` (ограничено 25 МРП = ${m.limit})` : ''}`)
  if (c.balance) lines.push(`Неиспользовано: ${c.balance.balance} дн.`)
  return lines.join('\n')
}
async function load() {
  loading.value = true
  try { items.value = (await api.get('/accounting/hr/absences', { params: { contractId: f.value.contractId || undefined, status: f.value.status || undefined } })) as any } catch (e) { showError(e) }
  loading.value = false
}
function openCreate() { n.value = { contractId: f.value.contractId || '', kind: 'ANNUAL_LEAVE', dateFrom: '', dateTo: '', days: 24, documentNumber: '', note: '' }; balance.value = null; if (n.value.contractId) loadBalance(); dlg.value = true }
async function loadBalance() { try { balance.value = n.value.contractId ? await api.get(`/accounting/hr/contracts/${n.value.contractId}/leave-balance`) : null } catch { balance.value = null } }
async function create() {
  busy.value = true
  try {
    const b = n.value.kind === 'ANNUAL_LEAVE' ? { kind: n.value.kind, dateFrom: n.value.dateFrom, days: n.value.days, note: n.value.note } : { kind: n.value.kind, dateFrom: n.value.dateFrom, dateTo: n.value.dateTo, documentNumber: n.value.documentNumber, note: n.value.note }
    await api.post(`/accounting/hr/contracts/${n.value.contractId}/absences`, b); dlg.value = false; ElMessage.success('Черновик сохранён — утвердите, чтобы рассчитать'); await load()
  } catch (e) { showError(e) }
  busy.value = false
}
async function approve(r: any) {
  try { const x = (await api.post(`/accounting/hr/absences/${r.id}/approve`, {})) as any; ElMessage.success(Number(x.amount) ? `Утверждено: ${fmtMoney(x.amount)} в зарплату ${x.payPeriod}` : 'Утверждено'); await load() } catch (e) { showError(e) }
}
async function cancel(r: any) {
  try {
    const reason = r.status === 'DRAFT' ? 'Удаление черновика' : (await ElMessageBox.prompt('Причина отмены', 'Отменить отсутствие', { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })).value
    await api.post(`/accounting/hr/absences/${r.id}/cancel`, { reason }); await load()
  } catch (e: any) { if (e !== 'cancel' && e !== 'close') showError(e) }
}
onMounted(async () => { try { staff.value = (await api.get('/accounting/hr/employees')) as any } catch { staff.value = [] } await load() })
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.calc { white-space: pre-wrap; font-size: 12px; margin: 0 16px; color: var(--el-text-color-regular); }
</style>
