<template>
  <!-- FP-054: регистр доходов упрощённой декларации (910.00) за полугодие: доходы по счетам, что входит в доход. -->
  <div>
    <div class="page-header">
      <h1>Доходы для упрощёнки</h1>
      <div class="actions">
        <el-select v-model="year" style="width: 100px;" @change="load"><el-option v-for="y in years" :key="y" :value="y" :label="y" /></el-select>
        <el-segmented v-model="period" :options="[{ label: '1 полугодие', value: 'H1' }, { label: '2 полугодие', value: 'H2' }]" @change="load" />
        <el-button type="primary" :loading="busy" @click="build">Собрать</el-button>
      </div>
    </div>
    <el-empty v-if="!reg" description="Регистр за полугодие ещё не собирался — нажмите «Собрать»" />
    <template v-else>
      <div class="state">
        <el-tag :type="reg.status === 'FIXED' ? 'success' : 'info'">{{ reg.status === 'FIXED' ? `Зафиксирован ${fmtDate(reg.fixedAt)}` : 'Черновик' }}</el-tag>
        <span class="muted">пакет {{ reg.packVersion }}</span>
        <span class="spacer" />
        <el-button v-if="reg.status === 'FIXED'" size="small" @click="verify">Перепроверить</el-button>
        <el-button v-if="reg.status === 'DRAFT' && org.can('acc.period.lock')" size="small" type="success" @click="fix">Зафиксировать</el-button>
      </div>
      <el-alert v-if="check" :type="check.same ? 'success' : 'error'" :closable="false" show-icon class="block"
        :title="check.same ? 'Регистр воспроизводится: учёт не менялся' : `Учёт изменился: доход ${fmtMoney(check.was.income)} → ${fmtMoney(check.now.income)}. Пересоберите и зафиксируйте заново.`" />
      <el-alert v-for="(i, k) in d.issues" :key="k" type="warning" :closable="false" show-icon class="block" :title="i.text" />
      <el-alert v-if="d.rule?.status === 'METHODOLOGIST_REVIEW'" type="info" :closable="false" show-icon class="block"
        title="Состав дохода — правило на проверке методолога: переоценки, курсовые разницы и восстановление обесценения не входят. Изменить — в учётной политике." />
      <div class="totals">
        <div class="total main"><div class="label">Доход за полугодие (910.00.001)</div><div class="value">{{ fmtMoney(d.income) }}</div></div>
        <div class="total"><div class="label">Предел для упрощёнки</div><div class="value">{{ fmtMoney(d.limit) }}</div></div>
      </div>
      <el-table :data="d.rows" size="small">
        <el-table-column label="Счёт" width="90" prop="account" />
        <el-table-column label="Наименование" min-width="320" prop="name" />
        <el-table-column label="Сумма" width="160" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
        <el-table-column label="В доходе" width="110" align="center"><template #default="{ row }"><el-tag :type="row.included ? 'success' : 'info'" size="small">{{ row.included ? 'да' : 'нет' }}</el-tag></template></el-table-column>
      </el-table>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, showError } from '../accounting/acc'

const org = useOrgStore()
const now = new Date()
const year = ref(now.getFullYear())
const years = [now.getFullYear() - 1, now.getFullYear()]
const period = ref(now.getMonth() < 6 ? 'H1' : 'H2')
const history = ref<any[]>([])
const busy = ref(false)
const check = ref<any>(null)
const reg = computed(() => history.value.find((r) => r.status === 'DRAFT') ?? history.value.find((r) => r.status === 'FIXED') ?? null)
const d = computed<any>(() => reg.value?.data ?? {})

async function load() {
  check.value = null
  try { history.value = ((await api.get('/accounting/tax/registers', { params: { year: year.value, kind: 'SIMPLIFIED' } })) as any).filter((r: any) => r.period === period.value) } catch (e) { showError(e) }
}
async function build() {
  busy.value = true
  try { await api.post('/accounting/tax/registers/simplified', { year: year.value, period: period.value }); await load() } catch (e) { showError(e) }
  busy.value = false
}
async function fix() {
  let reason: string | undefined
  if (history.value.some((r) => r.status === 'FIXED')) {
    try { reason = (await ElMessageBox.prompt('Регистр уже зафиксирован. Причина замены:', 'Зафиксировать заново', { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })).value } catch { return }
  }
  try { await api.post(`/accounting/tax/registers/${reg.value.id}/fix`, { reason }); ElMessage.success('Регистр зафиксирован'); await load() } catch (e) { showError(e) }
}
async function verify() {
  try { check.value = await api.get(`/accounting/tax/registers/${reg.value.id}/verify`) } catch (e) { showError(e) }
}
onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; }
.state { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.spacer { flex: 1; }
.block { margin-bottom: 12px; }
.totals { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 8px 0 20px; }
.total { background: var(--el-fill-color-light); border-radius: 8px; padding: 14px 16px; }
.total.main { background: var(--el-color-primary-light-9); }
.total .label { color: var(--el-text-color-secondary); font-size: 13px; }
.total .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
