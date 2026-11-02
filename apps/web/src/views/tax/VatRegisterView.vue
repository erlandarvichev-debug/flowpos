<template>
  <!-- FP-039: регистр НДС за квартал — обороты по ставкам, зачёт, к уплате; сверка с учётом; фиксация и перепроверка. -->
  <div>
    <div class="page-header">
      <h1>Регистр НДС</h1>
      <div class="actions">
        <el-select v-model="year" style="width: 100px;" @change="load"><el-option v-for="y in years" :key="y" :value="y" :label="y" /></el-select>
        <el-segmented v-model="period" :options="['Q1', 'Q2', 'Q3', 'Q4']" @change="load" />
        <el-button type="primary" :loading="busy" @click="build">Собрать</el-button>
      </div>
    </div>

    <el-empty v-if="!reg" description="Регистр за квартал ещё не собирался — нажмите «Собрать»" />
    <template v-else>
      <div class="state">
        <el-tag :type="reg.status === 'FIXED' ? 'success' : 'info'">{{ reg.status === 'FIXED' ? `Зафиксирован ${fmtDate(reg.fixedAt)}` : 'Черновик' }}</el-tag>
        <span class="muted">пакет {{ reg.packVersion }} · собран {{ dt(reg.createdAt) }}</span>
        <span class="spacer" />
        <el-button v-if="reg.status === 'FIXED'" size="small" @click="verify">Перепроверить</el-button>
        <el-button v-if="reg.status === 'DRAFT' && org.can('acc.period.lock')" size="small" type="success" :disabled="errors.length > 0" @click="fix">Зафиксировать</el-button>
      </div>
      <el-alert v-if="check" :type="check.same ? 'success' : 'error'" :closable="false" show-icon class="block"
        :title="check.same ? 'Регистр воспроизводится: учёт с момента фиксации не менялся' : `Учёт изменился после фиксации: НДС начислен ${fmtMoney(check.was.outputVat)} → ${fmtMoney(check.now.outputVat)}, к уплате ${fmtMoney(check.was.payable)} → ${fmtMoney(check.now.payable)}. Документов: ${check.changedDocs.length}. Пересоберите и зафиксируйте заново с причиной.`" />
      <el-alert v-for="(i, k) in d.issues" :key="k" :type="i.severity === 'ERROR' ? 'error' : 'warning'" :closable="false" show-icon class="block" :title="i.text">
        <el-link v-if="i.docId" type="primary" @click="router.push(`/accounting/trade/${i.docId}`)">Открыть документ</el-link>
      </el-alert>

      <div class="totals">
        <div class="total"><div class="label">НДС начислен</div><div class="value">{{ fmtMoney(d.output.vat) }}</div></div>
        <div class="total"><div class="label">НДС к зачёту</div><div class="value">{{ fmtMoney(d.input.credit) }}</div></div>
        <div class="total main"><div class="label">{{ Number(d.payable) >= 0 ? 'К уплате' : 'Превышение зачёта' }}</div><div class="value">{{ fmtMoney(Math.abs(Number(d.payable))) }}</div></div>
      </div>

      <h3>Облагаемый оборот по ставкам</h3>
      <el-table :data="d.output.byRate" size="small" class="block">
        <el-table-column label="Ставка" width="120"><template #default="{ row }">{{ Number(row.rate) }}%</template></el-table-column>
        <el-table-column label="Оборот без НДС" align="right"><template #default="{ row }">{{ fmtMoney(row.base) }}</template></el-table-column>
        <el-table-column label="НДС" align="right"><template #default="{ row }">{{ fmtMoney(row.vat) }}</template></el-table-column>
      </el-table>

      <el-tabs>
        <el-tab-pane :label="`Реализация и возвраты (${d.output.rows.length})`">
          <el-table :data="d.output.rows" size="small" @row-click="(r: any) => router.push(`/accounting/trade/${r.docId}`)" style="cursor: pointer;">
            <el-table-column label="Дата" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
            <el-table-column label="Документ" width="170" prop="number" />
            <el-table-column label="Покупатель" min-width="200"><template #default="{ row }">{{ row.counterparty ?? '—' }}<div class="muted">{{ row.counterpartyBin }}</div></template></el-table-column>
            <el-table-column label="Ставки" min-width="200"><template #default="{ row }"><div v-for="r in row.byRate" :key="r.rate">{{ Number(r.rate) }}%: {{ fmtMoney(r.base) }} / {{ fmtMoney(r.vat) }}</div></template></el-table-column>
            <el-table-column label="НДС" width="120" align="right"><template #default="{ row }"><span :class="{ bad: row.vat !== row.ledgerVat }">{{ fmtMoney(row.vat) }}</span></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`Зачёт по ЭСФ (${d.input.rows.length})`">
          <el-table :data="d.input.rows" size="small" empty-text="Зачёт за квартал не распределён — раздел «ЭСФ → Зачёт НДС»">
            <el-table-column label="ЭСФ" min-width="200"><template #default="{ row }">{{ row.registrationNumber ?? row.num }}<div class="muted">{{ fmtDate(row.date) }}</div></template></el-table-column>
            <el-table-column label="Поставщик" min-width="200"><template #default="{ row }">{{ row.seller ?? '—' }}<div class="muted">{{ row.sellerTin }}</div></template></el-table-column>
            <el-table-column label="Вид" width="160"><template #default="{ row }">{{ KIND[row.kind] ?? row.kind }}</template></el-table-column>
            <el-table-column label="Сумма" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`История (${history.length})`">
          <el-table :data="history" size="small">
            <el-table-column label="Статус" width="160"><template #default="{ row }">{{ STATUS[row.status] ?? row.status }}</template></el-table-column>
            <el-table-column label="Собран" width="170"><template #default="{ row }">{{ dt(row.createdAt) }}</template></el-table-column>
            <el-table-column label="К уплате" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.data.payable) }}</template></el-table-column>
            <el-table-column label="Причина замены" min-width="200" prop="supersedeReason" />
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, showError } from '../accounting/acc'

const router = useRouter()
const org = useOrgStore()
const now = new Date()
const year = ref(now.getFullYear())
const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
const period = ref(`Q${Math.floor(now.getMonth() / 3) + 1}`)
const history = ref<any[]>([])
const busy = ref(false)
const check = ref<any>(null)
const KIND: Record<string, string> = { CREDIT: 'В зачёт', REVERSAL: 'Сторно зачёта', NON_CREDITABLE: 'Не в зачёт (в расходы)' }
const STATUS: Record<string, string> = { DRAFT: 'Черновик', FIXED: 'Зафиксирован', SUPERSEDED: 'Заменён' }
const reg = computed(() => history.value.find((r) => r.status === 'DRAFT') ?? history.value.find((r) => r.status === 'FIXED') ?? null)
const d = computed<any>(() => reg.value?.data ?? {})
const errors = computed(() => (d.value.issues ?? []).filter((i: any) => i.severity === 'ERROR'))
const dt = (v: any) => (v ? new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '')

async function load() {
  check.value = null
  try { history.value = ((await api.get('/accounting/tax/registers', { params: { year: year.value, kind: 'VAT' } })) as any).filter((r: any) => r.period === period.value) } catch (e) { showError(e) }
}
async function build() {
  busy.value = true
  try { await api.post('/accounting/tax/registers/vat', { year: year.value, period: period.value }); await load() } catch (e) { showError(e) }
  busy.value = false
}
async function fix() {
  let reason: string | undefined
  if (history.value.some((r) => r.status === 'FIXED')) {
    try { reason = (await ElMessageBox.prompt('Регистр за квартал уже зафиксирован. Причина замены:', 'Зафиксировать заново', { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })).value } catch { return }
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
.totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 8px 0 20px; }
.total { background: var(--el-fill-color-light); border-radius: 8px; padding: 14px 16px; }
.total.main { background: var(--el-color-primary-light-9); }
.total .label { color: var(--el-text-color-secondary); font-size: 13px; }
.total .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
h3 { font-size: 15px; margin: 0 0 8px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.bad { color: var(--el-color-danger); font-weight: 600; }
</style>
