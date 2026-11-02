<template>
  <!-- FP-054: налоговые декларации — сборка из зафиксированного регистра, контрольные соотношения, готовность, сдача. -->
  <div>
    <div class="page-header">
      <h1>Декларации</h1>
      <div class="actions">
        <el-select v-model="form" style="width: 230px;" @change="onForm">
          <el-option v-for="f in forms" :key="f.form" :value="f.form" :label="`${f.form} — ${f.title}`" />
        </el-select>
        <el-select v-model="year" style="width: 100px;" @change="load"><el-option v-for="y in years" :key="y" :value="y" :label="y" /></el-select>
        <el-segmented v-if="cur" v-model="period" :options="cur.periods" @change="load" />
        <el-button type="primary" :loading="busy" :disabled="!cur" @click="build()">Составить</el-button>
      </div>
    </div>
    <el-alert v-if="cur && !cur.verified" type="warning" :closable="false" show-icon class="block" :title="cur.note || 'Структура строк формы требует сверки с текстом приказа МФ № 695'" />

    <el-empty v-if="!decl" description="Декларация за период не составлялась. Сначала зафиксируйте регистр, затем нажмите «Составить»." />
    <template v-else>
      <div class="state">
        <el-tag :type="TAG[decl.status]">{{ STATUS[decl.status] }}</el-tag>
        <span class="muted">{{ KIND[decl.kind] }} · пакет {{ decl.packVersion }} · {{ decl.header.name }}, БИН {{ decl.header.bin ?? '—' }}</span>
        <span v-if="decl.receipt" class="muted">· рег. № {{ decl.receipt.number }} от {{ fmtDate(decl.receipt.date) }}</span>
        <span class="spacer" />
        <el-button size="small" :loading="dl === 'pdf'" @click="download('pdf')">PDF</el-button>
        <el-button size="small" :loading="dl === 'xlsx'" @click="download('xlsx')">Excel</el-button>
        <template v-if="org.can('acc.period.lock')">
          <el-button v-if="decl.status === 'DRAFT'" type="success" size="small" :disabled="failed.length > 0" @click="finalize">Готова к сдаче</el-button>
          <el-button v-if="decl.status === 'FINAL'" size="small" type="primary" @click="submitted">Отметить сдачу</el-button>
          <template v-if="decl.status === 'SUBMITTED'">
            <el-button size="small" type="success" @click="result('ACCEPTED')">Принята</el-button>
            <el-button size="small" type="danger" @click="result('REJECTED')">Отказ в приёме</el-button>
          </template>
          <el-button v-if="['FINAL', 'SUBMITTED', 'ACCEPTED'].includes(decl.status)" size="small" @click="build('ADDITIONAL')">Дополнительная</el-button>
        </template>
      </div>
      <el-alert v-for="c in decl.checks.filter((x: any) => !x.ok)" :key="c.code" :type="c.severity === 'ERROR' ? 'error' : 'warning'" :closable="false" show-icon class="block" :title="c.severity === 'ERROR' ? `Не выполнено: ${c.text}` : `Внимание: ${c.hint ?? c.text}`" />

      <el-table :data="decl.lines" size="small" row-key="code">
        <el-table-column label="Код строки" width="190" prop="code" />
        <el-table-column label="Показатель" min-width="320"><template #default="{ row }">{{ row.name }}<div v-if="row.formula" class="muted">{{ row.formula }}</div></template></el-table-column>
        <el-table-column label="Сумма" width="170" align="right"><template #default="{ row }"><b>{{ fmtMoney(row.value) }}</b></template></el-table-column>
        <el-table-column label="Откуда" min-width="200"><template #default="{ row }"><span class="muted">{{ row.source }}</span></template></el-table-column>
      </el-table>

      <h3 v-if="history.length > 1">История за период</h3>
      <el-table v-if="history.length > 1" :data="history" size="small">
        <el-table-column label="Вид" width="170"><template #default="{ row }">{{ KIND[row.kind] }}</template></el-table-column>
        <el-table-column label="Статус" width="150"><template #default="{ row }">{{ STATUS[row.status] }}</template></el-table-column>
        <el-table-column label="Составлена" width="170"><template #default="{ row }">{{ dt(row.createdAt) }}</template></el-table-column>
        <el-table-column label="Рег. №" min-width="160"><template #default="{ row }">{{ row.receipt?.number ?? '' }}</template></el-table-column>
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
const forms = ref<any[]>([])
const form = ref('')
const now = new Date()
const year = ref(now.getFullYear())
const years = [now.getFullYear() - 1, now.getFullYear()]
const period = ref('')
const history = ref<any[]>([])
const busy = ref(false)
const dl = ref('')
async function download(format: 'pdf' | 'xlsx') {
  dl.value = format
  try {
    const blob = (await api.get(`/accounting/tax/declarations/${decl.value.id}/export`, { params: { format }, responseType: 'blob' })) as unknown as Blob
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${form.value.replace('.', '')}_${decl.value.header.bin ?? 'org'}_${year.value}${period.value}.${format}`
    a.click()
    URL.revokeObjectURL(a.href)
  } catch (e) { showError(e) }
  dl.value = ''
}
const STATUS: Record<string, string> = { DRAFT: 'Черновик', FINAL: 'Готова к сдаче', SUBMITTED: 'Сдана', ACCEPTED: 'Принята', REJECTED: 'Отказ в приёме' }
const TAG: Record<string, any> = { DRAFT: 'info', FINAL: 'primary', SUBMITTED: 'warning', ACCEPTED: 'success', REJECTED: 'danger' }
const KIND: Record<string, string> = { INITIAL: 'Первоначальная', ADDITIONAL: 'Дополнительная', LIQUIDATION: 'Ликвидационная', BY_NOTICE: 'По уведомлению' }
const cur = computed(() => forms.value.find((f) => f.form === form.value))
const decl = computed(() => history.value[0] ?? null)
const failed = computed(() => (decl.value?.checks ?? []).filter((c: any) => !c.ok && c.severity === 'ERROR'))
const dt = (v: any) => (v ? new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '')

function onForm() { period.value = cur.value?.periods?.[0] ?? ''; load() }
async function load() {
  if (!form.value) return
  try { history.value = ((await api.get('/accounting/tax/declarations', { params: { form: form.value, year: year.value } })) as any).filter((d: any) => d.period === period.value) } catch (e) { showError(e) }
}
async function build(kind?: string) {
  busy.value = true
  try { await api.post('/accounting/tax/declarations', { form: form.value, year: year.value, period: period.value, kind }); await load() } catch (e) { showError(e) }
  busy.value = false
}
async function finalize() {
  try { await api.post(`/accounting/tax/declarations/${decl.value.id}/finalize`, {}); ElMessage.success('Декларация готова к сдаче'); await load() } catch (e) { showError(e) }
}
async function submitted() {
  try {
    const { value } = await ElMessageBox.prompt('Регистрационный номер из кабинета налогоплательщика', 'Декларация сдана', { inputPattern: /\S+/, inputErrorMessage: 'Укажите номер' })
    await api.post(`/accounting/tax/declarations/${decl.value.id}/mark`, { status: 'SUBMITTED', number: value }); await load()
  } catch (e: any) { if (e !== 'cancel' && e !== 'close') showError(e) }
}
async function result(status: 'ACCEPTED' | 'REJECTED') {
  try {
    let note: string | undefined
    if (status === 'REJECTED') note = (await ElMessageBox.prompt('Причина отказа', 'Отказ в приёме', { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })).value
    await api.post(`/accounting/tax/declarations/${decl.value.id}/mark`, { status, note }); await load()
  } catch (e: any) { if (e !== 'cancel' && e !== 'close') showError(e) }
}
onMounted(async () => {
  try { forms.value = (await api.get('/accounting/tax/forms')) as any } catch (e) { showError(e) }
  if (forms.value.length) { form.value = forms.value[0].form; onForm() }
})
</script>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; }
.state { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.spacer { flex: 1; }
.block { margin-bottom: 12px; }
h3 { font-size: 15px; margin: 20px 0 8px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
