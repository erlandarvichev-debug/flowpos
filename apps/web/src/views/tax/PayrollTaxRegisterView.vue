<template>
  <!-- Регистр по зарплатным налогам и взносам за квартал (основа 200.00): из утверждённых расчётов зарплаты. -->
  <div>
    <div class="page-header">
      <h1>Налоги с зарплаты</h1>
      <div class="actions">
        <el-select v-model="year" style="width: 100px;" @change="load"><el-option v-for="y in years" :key="y" :value="y" :label="y" /></el-select>
        <el-segmented v-model="period" :options="['Q1', 'Q2', 'Q3', 'Q4']" @change="load" />
        <el-button type="primary" :loading="busy" @click="build">Собрать</el-button>
      </div>
    </div>
    <el-empty v-if="!reg" description="Регистр за квартал не собирался — нажмите «Собрать»" />
    <template v-else>
      <div class="state">
        <el-tag :type="reg.status === 'FIXED' ? 'success' : 'info'">{{ reg.status === 'FIXED' ? `Зафиксирован ${fmtDate(reg.fixedAt)}` : 'Черновик' }}</el-tag>
        <span class="spacer" />
        <el-button v-if="reg.status === 'DRAFT' && org.can('acc.period.lock')" size="small" type="success" :disabled="errors.length > 0" @click="fix">Зафиксировать</el-button>
        <el-button v-if="reg.status === 'FIXED'" size="small" @click="router.push('/tax/declarations')">К декларации 200.00</el-button>
      </div>
      <el-alert v-for="(i, k) in d.issues" :key="k" :type="i.severity === 'ERROR' ? 'error' : 'warning'" :closable="false" show-icon class="block" :title="i.text" />
      <el-table :data="rows" size="small">
        <el-table-column label="Показатель" min-width="220" prop="label" fixed />
        <el-table-column v-for="m in d.months" :key="m.month" :label="m.month" align="right" min-width="130"><template #default="{ row }">{{ fmtMoney(row.get(m)) }}</template></el-table-column>
        <el-table-column label="Итого" align="right" min-width="140"><template #default="{ row }"><b>{{ fmtMoney(d.months.reduce((s: number, m: any) => s + Number(row.get(m)), 0).toFixed(2)) }}</b></template></el-table-column>
      </el-table>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, showError } from '../accounting/acc'

const router = useRouter()
const org = useOrgStore()
const now = new Date()
const year = ref(now.getFullYear())
const years = [now.getFullYear() - 1, now.getFullYear()]
const period = ref(`Q${Math.floor(now.getMonth() / 3) + 1}`)
const history = ref<any[]>([])
const busy = ref(false)
const reg = computed(() => history.value.find((r) => r.status === 'DRAFT') ?? history.value.find((r) => r.status === 'FIXED') ?? null)
const d = computed<any>(() => reg.value?.data ?? { months: [], issues: [] })
const errors = computed(() => (d.value.issues ?? []).filter((i: any) => i.severity === 'ERROR'))
const rows = [
  { label: 'Начислено доходов', get: (m: any) => m.income }, { label: 'Облагаемый доход (ИПН)', get: (m: any) => m.taxable },
  { label: 'ИПН', get: (m: any) => m.ipn }, { label: 'ОПВ', get: (m: any) => m.opv }, { label: 'ВОСМС', get: (m: any) => m.vosms },
  { label: 'СН', get: (m: any) => m.sn }, { label: 'СО', get: (m: any) => m.so }, { label: 'ООСМС', get: (m: any) => m.oosms }, { label: 'ОПВР', get: (m: any) => m.opvr },
]

async function load() {
  try { history.value = ((await api.get('/accounting/tax/registers', { params: { year: year.value, kind: 'PAYROLL' } })) as any).filter((r: any) => r.period === period.value) } catch (e) { showError(e) }
}
async function build() {
  busy.value = true
  try { await api.post('/accounting/tax/registers/payroll', { year: year.value, period: period.value }); await load() } catch (e) { showError(e) }
  busy.value = false
}
async function fix() {
  let reason: string | undefined
  if (history.value.some((r) => r.status === 'FIXED')) {
    try { reason = (await ElMessageBox.prompt('Регистр уже зафиксирован. Причина замены:', 'Зафиксировать заново', { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })).value } catch { return }
  }
  try { await api.post(`/accounting/tax/registers/${reg.value.id}/fix`, { reason }); ElMessage.success('Регистр зафиксирован'); await load() } catch (e) { showError(e) }
}
onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; }
.state { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.spacer { flex: 1; }
.block { margin-bottom: 12px; }
</style>
