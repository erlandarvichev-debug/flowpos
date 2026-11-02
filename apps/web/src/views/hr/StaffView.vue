<template>
  <!-- Сотрудники (трудовые договоры): приём, кадровые изменения с даты, увольнение, разовые начисления. -->
  <div>
    <div class="page-header">
      <h1>Сотрудники</h1>
      <div class="actions">
        <el-button v-if="org.can('acc.refs.manage')" @click="deptDlg = true">Подразделения</el-button>
        <el-button v-if="org.can('hr.manage')" type="primary" :icon="Plus" @click="openHire">Принять на работу</el-button>
      </div>
    </div>
    <el-card>
      <div class="filters">
        <el-segmented v-model="status" :options="[{ label: 'Работают', value: 'ACTIVE' }, { label: 'Уволены', value: 'TERMINATED' }, { label: 'Все', value: '' }]" />
        <el-input v-model="search" clearable placeholder="ФИО, ИИН, № договора" style="width: 260px;" />
      </div>
      <el-table :data="shown" v-loading="loading" size="small">
        <el-table-column label="Сотрудник" min-width="220"><template #default="{ row }"><b>{{ row.name }}</b><div class="muted">ИИН {{ row.iin }}</div></template></el-table-column>
        <el-table-column label="Договор" width="130"><template #default="{ row }">{{ row.contractNumber }}<div class="muted">с {{ fmtDate(row.hireDate) }}</div></template></el-table-column>
        <el-table-column label="Подразделение" min-width="150"><template #default="{ row }">{{ deptName(row.departmentId) }}</template></el-table-column>
        <el-table-column label="Оклад" width="130" align="right"><template #default="{ row }">{{ row.salary ? fmtMoney(row.salary) : '•••' }}<div v-if="row.employmentRate && row.employmentRate !== '1'" class="muted">ставка {{ row.employmentRate }}</div></template></el-table-column>
        <el-table-column label="Состояние" width="140"><template #default="{ row }"><el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">{{ row.status === 'ACTIVE' ? 'Работает' : `Уволен ${fmtDate(row.fireDate)}` }}</el-tag></template></el-table-column>
        <el-table-column v-if="org.can('hr.manage')" label="" width="260">
          <template #default="{ row }">
            <template v-if="row.status === 'ACTIVE'">
              <el-button link size="small" @click="openChange(row)">Изменить</el-button>
              <el-button link size="small" @click="openAccrual(row)">Начисление</el-button>
              <el-button link size="small" type="danger" @click="openFire(row)">Уволить</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="hireDlg" title="Приём на работу" width="620px">
      <el-form :model="h" label-width="190px">
        <el-form-item label="ИИН"><el-input v-model="h.iin" maxlength="12" /></el-form-item>
        <el-form-item label="Фамилия"><el-input v-model="h.lastName" /></el-form-item>
        <el-form-item label="Имя"><el-input v-model="h.firstName" /></el-form-item>
        <el-form-item label="Отчество"><el-input v-model="h.middleName" /></el-form-item>
        <el-form-item label="Дата рождения"><el-date-picker v-model="h.birthDate" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Дата приёма"><el-date-picker v-model="h.hireDate" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Подразделение"><el-select v-model="h.departmentId" style="width: 100%;"><el-option v-for="d in depts" :key="d.id" :value="d.id" :label="d.name" /></el-select></el-form-item>
        <el-form-item label="Должность"><el-input v-model="h.positionName" placeholder="Сотрудник" /></el-form-item>
        <el-form-item label="Оклад в месяц"><el-input v-model="h.salary" /></el-form-item>
        <el-form-item label="Ставка"><el-input-number v-model="h.employmentRate" :min="0.1" :max="1" :step="0.25" /></el-form-item>
        <el-form-item label="Базовый вычет (заявление)"><el-switch v-model="h.applyStandardDeduction" /></el-form-item>
        <el-form-item label="Особенности">
          <el-checkbox v-model="h.isPensioner">пенсионер</el-checkbox>
          <el-checkbox v-model="h.fullTimeStudent">студент очной формы</el-checkbox>
          <el-checkbox v-model="h.isResident">резидент РК</el-checkbox>
        </el-form-item>
        <el-form-item label="Инвалидность"><el-select v-model="h.disabilityGroup" clearable placeholder="нет" style="width: 120px;"><el-option :value="1" label="I группа" /><el-option :value="2" label="II группа" /><el-option :value="3" label="III группа" /></el-select>
          <el-checkbox v-if="h.disabilityGroup" v-model="h.disabilityIndefinite" style="margin-left: 10px;">бессрочно</el-checkbox></el-form-item>
        <el-form-item label="IBAN для зарплаты"><el-input v-model="h.iban" placeholder="KZ…" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="hireDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="hire">Принять</el-button></template>
    </el-dialog>

    <el-dialog v-model="changeDlg" :title="`Кадровое изменение: ${cur?.name}`" width="480px">
      <el-form label-width="150px">
        <el-form-item label="С даты"><el-date-picker v-model="ch.validFrom" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Новый оклад"><el-input v-model="ch.salary" /></el-form-item>
        <el-form-item label="Подразделение"><el-select v-model="ch.departmentId" clearable style="width: 100%;"><el-option v-for="d in depts" :key="d.id" :value="d.id" :label="d.name" /></el-select></el-form-item>
        <el-form-item label="Комментарий"><el-input v-model="ch.comment" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="changeDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="change">Сохранить</el-button></template>
    </el-dialog>

    <el-dialog v-model="accrualDlg" :title="`Разовое начисление: ${cur?.name}`" width="460px">
      <el-form label-width="120px">
        <el-form-item label="Месяц"><el-date-picker v-model="ac.period" type="month" value-format="YYYY-MM" /></el-form-item>
        <el-form-item label="Вид"><el-select v-model="ac.type" style="width: 100%;"><el-option value="KPI_BONUS" label="Премия" /><el-option value="COMPENSATION" label="Компенсация" /><el-option value="INVENTORY_PENALTY" label="Удержание (недостача)" /></el-select></el-form-item>
        <el-form-item label="Сумма"><el-input v-model="ac.amount" /></el-form-item>
        <el-form-item label="Описание"><el-input v-model="ac.description" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="accrualDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="accrue">Добавить</el-button></template>
    </el-dialog>

    <el-dialog v-model="fireDlg" :title="`Увольнение: ${cur?.name}`" width="420px">
      <el-form label-width="120px"><el-form-item label="Дата"><el-date-picker v-model="fire.date" value-format="YYYY-MM-DD" /></el-form-item></el-form>
      <template #footer><el-button @click="fireDlg = false">Отмена</el-button><el-button type="danger" :loading="busy" @click="terminate">Уволить</el-button></template>
    </el-dialog>

    <el-dialog v-model="deptDlg" title="Подразделения" width="560px">
      <el-table :data="depts" size="small"><el-table-column label="Наименование" prop="name" /><el-table-column label="Счёт затрат" width="120" prop="costAccount" /></el-table>
      <div class="add-dept"><el-input v-model="nd.name" placeholder="Новое подразделение" /><el-select v-model="nd.costAccount" style="width: 220px;"><el-option value="7030" label="7030 Административные" /><el-option value="7020" label="7020 Реализация" /><el-option value="8110" label="8110 Производство" /></el-select><el-button type="primary" @click="addDept">Добавить</el-button></div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, showError } from '../accounting/acc'

const org = useOrgStore()
const items = ref<any[]>([])
const depts = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const status = ref('ACTIVE')
const search = ref('')
const today = new Date().toISOString().slice(0, 10)
const cur = ref<any>(null)
const hireDlg = ref(false), changeDlg = ref(false), accrualDlg = ref(false), fireDlg = ref(false), deptDlg = ref(false)
const h = ref<any>({}), ch = ref<any>({}), ac = ref<any>({}), fire = ref<any>({}), nd = ref<any>({ name: '', costAccount: '7030' })
const shown = computed(() => items.value.filter((x) => (!status.value || x.status === status.value) && (!search.value || `${x.name} ${x.iin} ${x.contractNumber}`.toLowerCase().includes(search.value.toLowerCase()))))
const deptName = (id: string) => depts.value.find((d) => d.id === id)?.name ?? '—'

async function load() {
  loading.value = true
  try {
    items.value = (await api.get('/accounting/hr/employees')) as any
    depts.value = (await api.get('/accounting/refs/departments')) as any
  } catch (e) { showError(e) }
  loading.value = false
}
function openHire() { h.value = { iin: '', lastName: '', firstName: '', middleName: '', birthDate: '', hireDate: today, departmentId: depts.value[0]?.id, positionName: '', salary: '', employmentRate: 1, applyStandardDeduction: true, isResident: true, isPensioner: false, fullTimeStudent: false, disabilityGroup: null, disabilityIndefinite: false, iban: '' }; hireDlg.value = true }
async function hire() {
  busy.value = true
  try { const r = (await api.post('/accounting/hr/hire', { ...h.value, iban: h.value.iban || undefined, positionName: h.value.positionName || undefined })) as any; ElMessage.success(`Принят по договору ${r.contractNumber}`); hireDlg.value = false; await load() } catch (e) { showError(e) }
  busy.value = false
}
function openChange(r: any) { cur.value = r; ch.value = { validFrom: today, salary: r.salary ?? '', departmentId: r.departmentId, comment: '' }; changeDlg.value = true }
async function change() {
  busy.value = true
  try { await api.post(`/accounting/hr/contracts/${cur.value.contractId}/change`, { ...ch.value, salary: ch.value.salary || undefined }); ElMessage.success('Изменение сохранено'); changeDlg.value = false; await load() } catch (e) { showError(e) }
  busy.value = false
}
function openAccrual(r: any) { cur.value = r; ac.value = { period: today.slice(0, 7), type: 'KPI_BONUS', amount: '', description: '' }; accrualDlg.value = true }
async function accrue() {
  busy.value = true
  try { await api.post(`/accounting/hr/contracts/${cur.value.contractId}/accruals`, ac.value); ElMessage.success('Начисление добавлено — пересчитайте зарплату за месяц'); accrualDlg.value = false } catch (e) { showError(e) }
  busy.value = false
}
function openFire(r: any) { cur.value = r; fire.value = { date: today }; fireDlg.value = true }
async function terminate() {
  busy.value = true
  try { await api.post(`/accounting/hr/contracts/${cur.value.contractId}/terminate`, fire.value); ElMessage.success('Сотрудник уволен'); fireDlg.value = false; await load() } catch (e) { showError(e) }
  busy.value = false
}
async function addDept() {
  try { await api.post('/accounting/refs/departments', nd.value); nd.value = { name: '', costAccount: '7030' }; depts.value = (await api.get('/accounting/refs/departments')) as any } catch (e) { showError(e) }
}
onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.add-dept { display: flex; gap: 8px; margin-top: 12px; }
</style>
