<template>
  <div v-loading="loading" @keydown="onKey">
    <div class="page-header">
      <h1>
        {{ DOC_TYPE_LABELS[docType] || docType }}
        <span v-if="doc.number" class="num">№ {{ doc.number }}</span>
        <el-tag v-if="doc.status" :type="STATUS_TYPES[doc.status] as any" style="margin-left: 8px;">{{ t(doc.status) }}</el-tag>
        <span v-if="doc.version" class="ver">версия {{ doc.version }}</span>
      </h1>
      <div class="actions">
        <el-button @click="router.push('/accounting/documents')">К списку</el-button>
        <template v-if="!readonly">
          <el-button type="primary" plain :loading="busy" @click="save()" v-if="org.can('acc.doc.write')">{{ t('save') }}</el-button>
          <el-button type="success" :loading="busy" @click="post" v-if="org.can('acc.doc.post') && doc.status !== 'POSTED'">{{ t('post') }}</el-button>
        </template>
        <el-dropdown v-if="isSaved" @command="onCommand" trigger="click">
          <el-button>Ещё <el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-if="doc.status === 'POSTED' && org.can('acc.doc.post') && docType !== 'STORNO'" command="unpost">{{ t('unpost') }}</el-dropdown-item>
              <el-dropdown-item v-if="doc.status === 'POSTED' && org.can('acc.doc.post') && docType !== 'STORNO'" command="storno">{{ t('storno') }}…</el-dropdown-item>
              <el-dropdown-item v-if="doc.status === 'POSTED' && docType === 'STORNO' && org.can('acc.doc.post')" command="unpost">{{ t('unpost') }}</el-dropdown-item>
              <el-dropdown-item v-if="docType !== 'STORNO' && org.can('acc.doc.write')" command="copy">{{ t('copy') }}</el-dropdown-item>
              <el-dropdown-item v-if="doc.status !== 'CANCELLED' && org.can('acc.doc.cancel')" command="cancel" divided>{{ t('cancel') }}</el-dropdown-item>
              <el-dropdown-item v-if="doc.status === 'CANCELLED' && org.can('acc.doc.cancel')" command="restore">{{ t('restore') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <el-alert v-if="doc.status === 'POSTED' && !readonly" type="warning" :closable="false" show-icon style="margin-bottom: 12px;"
      title="Документ проведён. Изменения сохранятся новой версией с указанием причины и будут сразу перепроведены." />
    <el-alert v-if="docType === 'STORNO'" type="info" :closable="false" show-icon style="margin-bottom: 12px;"
      :title="`Сторно документа ${doc.body?.originalNumber || ''}. Причина: ${doc.body?.reason || doc.comment || ''}`" />

    <el-card style="margin-bottom: 12px;">
      <el-form label-width="120px" class="head-form">
        <el-form-item :label="t('date')">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :disabled="readonly" :clearable="false" />
        </el-form-item>
        <el-form-item :label="t('comment')">
          <el-input v-model="form.comment" :disabled="readonly" style="max-width: 600px;" />
        </el-form-item>
        <el-form-item v-if="doc.status === 'POSTED' && !readonly" :label="t('reason')" required>
          <el-input v-model="form.reason" placeholder="Причина изменения проведённого документа" style="max-width: 600px;" />
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-if="isMoney">
      <template #header><div class="card-head"><span>{{ DOC_TYPE_LABELS[docType] }}</span><span class="totals">{{ t('amount') }}: <b>{{ fmtMoney(money.amount) }}</b> ₸</span></div></template>
      <el-form label-width="190px" class="head-form">
        <el-form-item :label="moneyIsBank ? t('bankAccount') : t('cashbox')" required>
          <div style="width: 380px;"><DimSelect :dim="moneyIsBank ? 'BANK_ACCOUNT' : 'CASHBOX'" v-model="money.selfId" size="default" :disabled="readonly" /></div>
        </el-form-item>
        <el-form-item :label="t('operation')" required>
          <el-select v-model="money.operation" :disabled="readonly" style="width: 380px;">
            <el-option v-for="op in moneyOps.operations[docType] || []" :key="op" :value="op" :label="moneyOps.labels[op] || op" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="['CUSTOMER', 'SUPPLIER'].includes(money.operation)" :label="t('counterparty')" required>
          <div style="width: 380px;"><DimSelect dim="COUNTERPARTY" v-model="money.counterpartyId" size="default" :disabled="readonly" /></div>
          <span class="hint">Долг закрывается автоматически, остаток уходит в аванс</span>
        </el-form-item>
        <el-form-item v-if="money.operation === 'TRANSFER'" :label="t('toAccount')" required>
          <el-radio-group v-model="money.toKind" :disabled="readonly" size="small" style="margin-right: 8px;">
            <el-radio-button value="BANK">{{ t('bankAccount') }}</el-radio-button><el-radio-button value="CASH">{{ t('cashbox') }}</el-radio-button>
          </el-radio-group>
          <div style="width: 300px;"><DimSelect :dim="money.toKind === 'CASH' ? 'CASHBOX' : 'BANK_ACCOUNT'" v-model="money.toId" :key="money.toKind" size="default" :disabled="readonly" /></div>
        </el-form-item>
        <el-form-item v-if="money.operation === 'FROM_BANK'" :label="t('fromBank')" required>
          <div style="width: 380px;"><DimSelect dim="BANK_ACCOUNT" v-model="money.fromBankAccountId" size="default" :disabled="readonly" /></div>
        </el-form-item>
        <el-form-item v-if="['ACCOUNTABLE', 'ACCOUNTABLE_RETURN'].includes(money.operation)" :label="t('employee')" required>
          <div style="width: 380px;"><DimSelect dim="EMPLOYEE" v-model="money.employeeId" size="default" :disabled="readonly" /></div>
        </el-form-item>
        <el-form-item v-if="money.operation === 'ACQUIRING'" label="Комиссия банка">
          <el-input v-model="money.commission" :disabled="readonly" placeholder="0.00" style="width: 200px;" />
          <span class="hint" style="margin-left: 8px;">Сумма выше — зачислено на счёт; с «Денег в пути» (1020) спишется сумма + комиссия</span>
        </el-form-item>
        <template v-if="money.operation === 'OTHER'">
          <el-form-item :label="t('corr')" required>
            <div style="width: 380px;"><AccountSelect v-model="money.corrAccount" :accounts="accounts" @update:model-value="() => onAccount({ account: money.corrAccount, dims: money.corrDims })" /></div>
          </el-form-item>
          <el-form-item v-for="d in acc(money.corrAccount)?.dims || []" :key="d" :label="DIM_LABELS[d] || d">
            <div style="width: 380px;"><DimSelect :dim="d" v-model="money.corrDims[d]" size="default" :disabled="readonly" /></div>
          </el-form-item>
        </template>
        <el-form-item v-if="moneyCurrency !== 'KZT'" :label="`${t('currencyAmount')}, ${moneyCurrency}`" required>
          <el-input v-model="money.currencyAmount" :disabled="readonly" style="width: 200px;" class="amt" />
          <span class="hint">Сумма в тенге будет рассчитана по курсу на дату документа</span>
        </el-form-item>
        <el-form-item v-else :label="`${t('amount')}, ₸`" required>
          <el-input v-model="money.amount" :disabled="readonly" style="width: 200px;" class="amt" placeholder="0.00" />
        </el-form-item>
        <el-form-item :label="t('cashFlowItem')">
          <div style="width: 380px;"><DimSelect dim="ITEM" v-model="money.itemId" size="default" :disabled="readonly" /></div>
        </el-form-item>
        <el-form-item :label="t('purpose')">
          <el-input v-model="money.purpose" :disabled="readonly" style="max-width: 600px;" />
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-if="docType !== 'STORNO' && !isMoney">
      <template #header>
        <div class="card-head">
          <span>{{ t('lines') }}</span>
          <span class="totals">
            {{ t('debit') }}: <b>{{ fmtMoney(totals.d) }}</b> &nbsp; {{ t('credit') }}: <b>{{ fmtMoney(totals.c) }}</b>
          </span>
        </div>
      </template>

      <div class="lines" ref="linesEl">
        <!-- Операция: Дт / Кт / сумма -->
        <template v-if="docType === 'MANUAL_OPERATION'">
          <div class="line head">
            <div class="c-no">№</div><div class="c-side">{{ t('debit') }}</div><div class="c-side">{{ t('credit') }}</div>
            <div class="c-amt">{{ t('amount') }}, ₸</div><div class="c-memo">Содержание</div><div class="c-led">Учёт</div><div class="c-del"></div>
          </div>
          <div v-for="(l, i) in form.lines" :key="i" class="line">
            <div class="c-no">{{ i + 1 }}</div>
            <div class="c-side" v-for="s in (['debit', 'credit'] as const)" :key="s">
              <AccountSelect v-model="l[s].account" :accounts="accounts" :disabled="readonly" @update:model-value="() => onAccount(l[s])" />
              <div v-for="d in acc(l[s].account)?.dims || []" :key="d" class="sub">
                <DimSelect :dim="d" v-model="l[s].dims[d]" :disabled="readonly" :class="{ required: acc(l[s].account)?.requiredDims?.includes(d) }" />
              </div>
              <div v-if="acc(l[s].account)?.isQuantitative" class="sub">
                <el-input v-model="l[s].quantity" size="small" placeholder="Количество" :disabled="readonly" />
              </div>
              <div v-if="acc(l[s].account)?.isCurrency" class="sub cur">
                <el-select v-model="l[s].currency" size="small" placeholder="Валюта" clearable style="width: 90px;" :disabled="readonly">
                  <el-option v-for="c in currencies" :key="c.code" :value="c.code" :label="c.code" />
                </el-select>
                <el-input v-if="l[s].currency && l[s].currency !== 'KZT'" v-model="l[s].currencyAmount" size="small" placeholder="Сумма в валюте" :disabled="readonly" />
              </div>
            </div>
            <div class="c-amt"><el-input v-model="l.amount" size="small" class="nav-field amt" :disabled="readonly" placeholder="0.00" /></div>
            <div class="c-memo"><el-input v-model="l.memo" size="small" class="nav-field" :disabled="readonly" /></div>
            <div class="c-led">
              <el-select v-model="l.ledger" size="small" :disabled="readonly">
                <el-option value="BU" label="БУ" /><el-option value="NU" label="НУ" /><el-option value="BOTH" label="БУ+НУ" />
              </el-select>
            </div>
            <div class="c-del"><el-button v-if="!readonly" link type="danger" :icon="Delete" @click="form.lines.splice(i, 1)" /></div>
          </div>
        </template>

        <!-- Ввод остатков: счёт / сальдо Дт-Кт -->
        <template v-else>
          <div class="line head">
            <div class="c-no">№</div><div class="c-side wide">{{ t('account') }} и аналитика</div><div class="c-dc">Сальдо</div>
            <div class="c-amt">{{ t('amount') }}, ₸</div><div class="c-memo">Содержание</div><div class="c-led">Учёт</div><div class="c-del"></div>
          </div>
          <div v-for="(l, i) in form.lines" :key="i" class="line">
            <div class="c-no">{{ i + 1 }}</div>
            <div class="c-side wide">
              <AccountSelect v-model="l.account" :accounts="accounts" :disabled="readonly" @update:model-value="() => onAccount(l)" />
              <div v-for="d in acc(l.account)?.dims || []" :key="d" class="sub">
                <DimSelect :dim="d" v-model="l.dims[d]" :disabled="readonly" />
              </div>
              <div v-if="acc(l.account)?.isQuantitative" class="sub"><el-input v-model="l.quantity" size="small" placeholder="Количество" :disabled="readonly" /></div>
              <div v-if="acc(l.account)?.isCurrency" class="sub cur">
                <el-select v-model="l.currency" size="small" placeholder="Валюта" clearable style="width: 90px;">
                  <el-option v-for="c in currencies" :key="c.code" :value="c.code" :label="c.code" />
                </el-select>
                <el-input v-if="l.currency && l.currency !== 'KZT'" v-model="l.currencyAmount" size="small" placeholder="Сумма в валюте" />
              </div>
            </div>
            <div class="c-dc">
              <el-radio-group v-model="l.side" size="small" :disabled="readonly">
                <el-radio-button value="D">Дт</el-radio-button><el-radio-button value="C">Кт</el-radio-button>
              </el-radio-group>
            </div>
            <div class="c-amt"><el-input v-model="l.amount" size="small" class="nav-field amt" :disabled="readonly" placeholder="0.00" /></div>
            <div class="c-memo"><el-input v-model="l.memo" size="small" class="nav-field" :disabled="readonly" /></div>
            <div class="c-led">
              <el-select v-model="l.ledger" size="small" :disabled="readonly" placeholder="БУ+НУ" clearable>
                <el-option value="BU" label="БУ" /><el-option value="NU" label="НУ" />
              </el-select>
            </div>
            <div class="c-del"><el-button v-if="!readonly" link type="danger" :icon="Delete" @click="form.lines.splice(i, 1)" /></div>
          </div>
        </template>
      </div>
      <div style="margin-top: 10px;" v-if="!readonly">
        <el-button :icon="Plus" size="small" @click="addLine">{{ t('addLine') }}</el-button>
        <span class="hint">Ctrl+Enter — новая строка, Enter в сумме/содержании — следующее поле, Ctrl+S — сохранить</span>
      </div>
    </el-card>

    <el-card v-if="isSaved" style="margin-top: 12px;">
      <el-tabs>
        <el-tab-pane :label="`${t('postings')} (${doc.entry?.postings?.length || 0})`">
          <div v-if="doc.entry" class="entry-meta">Правило {{ doc.entry.ruleCode }} v{{ doc.entry.ruleVersion }}, версия документа {{ doc.entry.sourceVersion }}</div>
          <el-table :data="doc.entry?.postings || []" size="small" empty-text="Документ не проведён">
            <el-table-column label="№" prop="lineNo" width="50" />
            <el-table-column label="Учёт" prop="ledger" width="60" />
            <el-table-column label="Дт/Кт" width="70"><template #default="{ row }">{{ row.side === 'D' ? 'Дт' : 'Кт' }}</template></el-table-column>
            <el-table-column :label="t('account')" min-width="260">
              <template #default="{ row }"><b>{{ row.account?.code }}</b> {{ nm(row.account) }}</template>
            </el-table-column>
            <el-table-column :label="t('amount')" width="150" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
            <el-table-column label="Кол-во" width="100" align="right" prop="quantity" />
            <el-table-column label="Валюта" width="140"><template #default="{ row }">{{ row.currency ? `${fmtMoney(row.currencyAmount)} ${row.currency}` : '' }}</template></el-table-column>
            <el-table-column label="Содержание" prop="memo" min-width="160" show-overflow-tooltip />
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="t('related')">
          <el-table :data="doc.related || []" size="small" empty-text="Нет связанных документов" @row-click="(r: any) => router.push(`/accounting/documents/${r.id}`)" style="cursor: pointer;">
            <el-table-column label="Связь" width="160">
              <template #default="{ row }">{{ relation(row) }}</template>
            </el-table-column>
            <el-table-column :label="t('type')" min-width="160"><template #default="{ row }">{{ DOC_TYPE_LABELS[row.docType] || row.docType }}</template></el-table-column>
            <el-table-column :label="t('number')" prop="number" width="170" />
            <el-table-column :label="t('date')" width="110"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
            <el-table-column :label="t('amount')" width="150" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
            <el-table-column :label="t('status')" width="140"><template #default="{ row }"><el-tag size="small" :type="STATUS_TYPES[row.status] as any">{{ t(row.status) }}</el-tag></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="t('history')">
          <el-timeline style="padding-top: 8px;">
            <el-timeline-item v-for="v in [...(doc.versions || [])].reverse()" :key="v.id" :timestamp="new Date(v.createdAt).toLocaleString('ru-RU')">
              <b>{{ ACTION_LABELS[v.action] || v.action }}</b> · версия {{ v.version }}
              <span v-if="v.reason"> · причина: {{ v.reason }}</span>
              <div class="hint">Сумма {{ fmtMoney(v.snapshot?.amount) }}, дата {{ fmtDate(v.snapshot?.date) }}, статус {{ t(v.snapshot?.status) }}</div>
            </el-timeline-item>
          </el-timeline>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="stornoVisible" title="Сторно документа" width="460px">
      <el-form label-width="110px">
        <el-form-item label="Дата сторно"><el-date-picker v-model="stornoForm.date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" /></el-form-item>
        <el-form-item label="Причина" required><el-input v-model="stornoForm.reason" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <div class="hint">Исходный документ не изменится. Будет создан и проведён документ сторно с обратными проводками на выбранную дату (в открытом периоде).</div>
      <template #footer>
        <el-button @click="stornoVisible = false">{{ t('close') }}</el-button>
        <el-button type="danger" :loading="busy" :disabled="!stornoForm.reason" @click="doStorno">{{ t('storno') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Delete, ArrowDown } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import AccountSelect from '@/components/accounting/AccountSelect.vue'
import DimSelect from '@/components/accounting/DimSelect.vue'
import { DIM_LABELS, DOC_TYPE_LABELS, MONEY_DOC_TYPES, STATUS_TYPES, addMoney, fmtDate, fmtMoney, idem, normAmount, showError } from './acc'

const route = useRoute()
const router = useRouter()
const org = useOrgStore()
const { t, nm } = useI18n()

const ACTION_LABELS: Record<string, string> = {
  CREATE: 'Создан', UPDATE: 'Изменён', POST: 'Проведён', UNPOST: 'Проведение отменено', CANCEL: 'Помечен на удаление', RESTORE: 'Восстановлен',
}

const loading = ref(false)
const busy = ref(false)
const accounts = ref<any[]>([])
const currencies = ref<any[]>([])
const doc = ref<any>({})
const form = ref<any>({ date: dayjs().format('YYYY-MM-DD'), comment: '', reason: '', lines: [] })
const stornoVisible = ref(false)
const stornoForm = ref({ date: dayjs().format('YYYY-MM-DD'), reason: '' })
const linesEl = ref<HTMLElement>()
const moneyOps = ref<{ operations: Record<string, string[]>; labels: Record<string, string> }>({ operations: {}, labels: {} })
const bankAccounts = ref<any[]>([])
const cashboxes = ref<any[]>([])
const emptyMoney = () => ({
  selfId: undefined as string | undefined, operation: '', counterpartyId: undefined as string | undefined, amount: '', currencyAmount: '',
  toKind: 'BANK', toId: undefined as string | undefined, fromBankAccountId: undefined as string | undefined, employeeId: undefined as string | undefined,
  corrAccount: '', corrDims: {} as Record<string, string>, itemId: undefined as string | undefined, purpose: '', commission: '',
})
const money = ref<any>(emptyMoney())

const isSaved = computed(() => !!doc.value.id)
const isMoney = computed(() => MONEY_DOC_TYPES.includes(docType.value))
const moneyIsBank = computed(() => docType.value.startsWith('BANK_'))
const moneyCurrency = computed(() => {
  const list = moneyIsBank.value ? bankAccounts.value : cashboxes.value
  return list.find((x) => x.id === money.value.selfId)?.currency || 'KZT'
})
const docType = computed<string>(() => doc.value.docType || (route.query.type as string) || 'MANUAL_OPERATION')
const readonly = computed(() => doc.value.status === 'CANCELLED' || docType.value === 'STORNO' || !org.can('acc.doc.write')
  || (doc.value.status === 'POSTED' && !org.can('acc.doc.post')))
const accMap = computed(() => new Map(accounts.value.map((a) => [a.code, a])))
const acc = (code?: string) => (code ? accMap.value.get(code) : undefined)

const totals = computed(() => {
  const lines = form.value.lines || []
  if (isMoney.value) return { d: money.value.amount, c: money.value.amount }
  if (docType.value === 'MANUAL_OPERATION') {
    const s = addMoney(lines.map((l: any) => l.amount))
    return { d: s, c: s }
  }
  return {
    d: addMoney(lines.filter((l: any) => l.side === 'D').map((l: any) => l.amount)),
    c: addMoney(lines.filter((l: any) => l.side === 'C').map((l: any) => l.amount)),
  }
})

function emptySide() { return { account: '', dims: {} as Record<string, string>, quantity: '', currency: '', currencyAmount: '' } }
function emptyLine() {
  return docType.value === 'MANUAL_OPERATION'
    ? { amount: '', memo: '', ledger: 'BU', debit: emptySide(), credit: emptySide() }
    : { account: '', side: 'D', amount: '', memo: '', ledger: undefined, dims: {}, quantity: '', currency: '', currencyAmount: '' }
}

function normSide(s: any) {
  return { account: s?.account || '', dims: { ...(s?.dims || {}) }, quantity: s?.quantity ?? '', currency: s?.currency || '', currencyAmount: s?.currencyAmount ?? '' }
}

function fillMoney(b: any, type: string) {
  const isBank = type.startsWith('BANK_')
  const toKind = b.toCashboxId ? 'CASH' : 'BANK'
  money.value = {
    ...emptyMoney(), selfId: isBank ? b.bankAccountId : b.cashboxId, operation: b.operation || '', counterpartyId: b.counterpartyId,
    amount: b.amount ?? '', currencyAmount: b.currencyAmount ?? '', toKind, toId: b.toCashboxId || b.toBankAccountId,
    fromBankAccountId: b.fromBankAccountId, employeeId: b.employeeId, corrAccount: b.corrAccount || '', corrDims: { ...(b.corrDims || {}) },
    itemId: b.itemId, purpose: b.purpose || '', commission: b.commission ?? '',
  }
}

function moneyBody() {
  const m = money.value
  const b: any = { operation: m.operation, purpose: m.purpose || undefined, itemId: m.itemId || undefined }
  if (moneyIsBank.value) b.bankAccountId = m.selfId; else b.cashboxId = m.selfId
  if (moneyCurrency.value !== 'KZT') b.currencyAmount = normAmount(m.currencyAmount)
  else b.amount = normAmount(m.amount)
  if (['CUSTOMER', 'SUPPLIER'].includes(m.operation)) b.counterpartyId = m.counterpartyId
  if (m.operation === 'TRANSFER') { if (m.toKind === 'CASH') b.toCashboxId = m.toId; else b.toBankAccountId = m.toId }
  if (m.operation === 'FROM_BANK') b.fromBankAccountId = m.fromBankAccountId
  if (['ACCOUNTABLE', 'ACCOUNTABLE_RETURN'].includes(m.operation)) b.employeeId = m.employeeId
  if (m.operation === 'ACQUIRING' && m.commission) b.commission = normAmount(m.commission)
  if (m.operation === 'OTHER') {
    b.corrAccount = m.corrAccount
    const dims = Object.fromEntries(Object.entries(m.corrDims || {}).filter(([, v]) => !!v))
    if (Object.keys(dims).length) b.corrDims = dims
  }
  return b
}

function fillForm(d: any) {
  if (MONEY_DOC_TYPES.includes(d.docType)) fillMoney(d.body || {}, d.docType)
  const lines = (d.body?.lines || []).map((l: any) => (d.docType === 'MANUAL_OPERATION'
    ? { amount: l.amount ?? '', memo: l.memo || '', ledger: l.ledger || 'BU', debit: normSide(l.debit), credit: normSide(l.credit) }
    : { ...normSide(l), side: l.side || 'D', amount: l.amount ?? '', memo: l.memo || '', ledger: l.ledger }))
  form.value = { date: String(d.date).slice(0, 10), comment: d.comment || '', reason: '', lines }
}

/** Убирает аналитики, которых нет у выбранного счёта. */
function onAccount(side: any) {
  const a = acc(side.account)
  const allowed = new Set(a?.dims || [])
  for (const k of Object.keys(side.dims || {})) if (!allowed.has(k)) delete side.dims[k]
  if (!a?.isQuantitative) side.quantity = ''
  if (!a?.isCurrency) { side.currency = ''; side.currencyAmount = '' }
}

function cleanSide(s: any) {
  const out: any = { account: s.account }
  const dims = Object.fromEntries(Object.entries(s.dims || {}).filter(([, v]) => !!v))
  if (Object.keys(dims).length) out.dims = dims
  if (String(s.quantity ?? '').trim()) out.quantity = normAmount(s.quantity)
  if (s.currency && s.currency !== 'KZT') { out.currency = s.currency; out.currencyAmount = normAmount(s.currencyAmount) }
  return out
}

function buildBody() {
  if (isMoney.value) return moneyBody()
  const lines = (form.value.lines || []).map((l: any) => {
    if (docType.value === 'MANUAL_OPERATION') {
      return { amount: normAmount(l.amount), memo: l.memo || undefined, ledger: l.ledger || 'BU', debit: cleanSide(l.debit), credit: cleanSide(l.credit) }
    }
    return { ...cleanSide(l), side: l.side, amount: normAmount(l.amount), memo: l.memo || undefined, ...(l.ledger ? { ledger: l.ledger } : {}) }
  })
  return { lines }
}

function addLine() {
  form.value.lines.push(emptyLine())
  nextTick(() => {
    const inputs = linesEl.value?.querySelectorAll<HTMLInputElement>('.line:last-child input')
    inputs?.[0]?.focus()
  })
}

function relation(r: any) {
  if (r.id === doc.value.baseDocumentId && r.id === doc.value.reversalOfId) return 'Сторнирует'
  if (r.id === doc.value.baseDocumentId) return 'Основание'
  if (r.reversalOfId === doc.value.id) return 'Сторно этого документа'
  if (r.baseDocumentId === doc.value.id) return 'Создан на основании'
  return ''
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !readonly.value && !isMoney.value) { e.preventDefault(); addLine(); return }
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'ы')) { e.preventDefault(); if (!readonly.value) save(); return }
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    const target = e.target as HTMLElement
    if (!target.closest('.nav-field')) return
    e.preventDefault()
    const fields = Array.from(linesEl.value?.querySelectorAll<HTMLInputElement>('.nav-field input') || [])
    const idx = fields.indexOf(target as HTMLInputElement)
    if (idx >= 0 && idx < fields.length - 1) fields[idx + 1].focus()
    else addLine()
  }
}

async function loadRefs() {
  try {
    accounts.value = (await api.get('/accounting/chart')) as any
    currencies.value = (await api.get('/accounting/refs/currencies')) as any
    moneyOps.value = (await api.get('/accounting/money-operations')) as any
    bankAccounts.value = (await api.get('/accounting/refs/bank-accounts')) as any
    cashboxes.value = (await api.get('/accounting/refs/cashboxes')) as any
  } catch (e) { showError(e) }
}

async function load() {
  const id = route.params.id as string | undefined
  if (!id || id === 'new') {
    doc.value = {}
    form.value = { date: dayjs().format('YYYY-MM-DD'), comment: '', reason: '', lines: isMoney.value ? [] : [emptyLine()] }
    money.value = emptyMoney()
    const ops = moneyOps.value.operations[docType.value]
    if (ops?.length) money.value.operation = ops[0]
    const list = moneyIsBank.value ? bankAccounts.value : cashboxes.value
    if (isMoney.value && list.length === 1) money.value.selfId = list[0].id
    return
  }
  loading.value = true
  try {
    doc.value = (await api.get(`/accounting/documents/${id}`)) as any
    fillForm(doc.value)
  } catch (e) { showError(e) }
  loading.value = false
}

async function handleConflict(e: any) {
  if (e?.code === 'VERSION_CONFLICT') {
    try {
      await ElMessageBox.confirm(`${e.message}. Загрузить актуальную версию? Несохранённые изменения будут потеряны.`, 'Конфликт версий', { type: 'warning', confirmButtonText: 'Загрузить', cancelButtonText: 'Остаться' })
      await load()
    } catch { /* остаёмся */ }
    return true
  }
  return false
}

async function save(silent = false): Promise<boolean> {
  if (doc.value.status === 'POSTED' && !form.value.reason) {
    ElMessage.warning('Укажите причину изменения проведённого документа')
    return false
  }
  busy.value = true
  try {
    if (!isSaved.value) {
      const created = (await api.post('/accounting/documents', {
        docType: docType.value, date: form.value.date, comment: form.value.comment, body: buildBody(),
      }, idem())) as any
      if (!silent) ElMessage.success(`Сохранён ${created.number}`)
      await router.replace(`/accounting/documents/${created.id}`)
      doc.value = (await api.get(`/accounting/documents/${created.id}`)) as any
      fillForm(doc.value)
    } else {
      await api.put(`/accounting/documents/${doc.value.id}`, {
        expectedVersion: doc.value.version, date: form.value.date, comment: form.value.comment, body: buildBody(),
        reason: form.value.reason || undefined,
      }, idem())
      if (!silent) ElMessage.success('Сохранено')
      await load()
    }
    busy.value = false
    return true
  } catch (e: any) {
    busy.value = false
    if (!(await handleConflict(e))) showError(e)
    return false
  }
}

async function post() {
  if (!(await save(true))) return
  busy.value = true
  try {
    await api.post(`/accounting/documents/${doc.value.id}/post`, { expectedVersion: doc.value.version }, idem())
    ElMessage.success('Документ проведён')
    await load()
  } catch (e: any) {
    if (!(await handleConflict(e))) showError(e)
  }
  busy.value = false
}

async function action(path: string, body: any = {}, msg = 'Готово') {
  busy.value = true
  try {
    await api.post(`/accounting/documents/${doc.value.id}/${path}`, body, idem())
    ElMessage.success(msg)
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

async function onCommand(cmd: string) {
  if (cmd === 'unpost') return action('unpost', {}, 'Проведение отменено')
  if (cmd === 'restore') return action('restore', {}, 'Документ восстановлен')
  if (cmd === 'cancel') {
    try {
      const { value } = await ElMessageBox.prompt('Документ будет помечен на удаление, проводки отменены. Причина:', 'Пометка на удаление', { confirmButtonText: 'Пометить', cancelButtonText: 'Отмена' })
      return action('cancel', { reason: value || undefined }, 'Помечен на удаление')
    } catch { return }
  }
  if (cmd === 'storno') {
    stornoForm.value = { date: dayjs().format('YYYY-MM-DD'), reason: '' }
    stornoVisible.value = true
    return
  }
  if (cmd === 'copy') {
    busy.value = true
    try {
      const created = (await api.post('/accounting/documents', {
        docType: docType.value, date: dayjs().format('YYYY-MM-DD'), comment: form.value.comment, body: buildBody(), baseDocumentId: doc.value.id,
      }, idem())) as any
      ElMessage.success(`Создана копия ${created.number}`)
      await router.push(`/accounting/documents/${created.id}`)
    } catch (e) { showError(e) }
    busy.value = false
  }
}

async function doStorno() {
  busy.value = true
  try {
    const st = (await api.post(`/accounting/documents/${doc.value.id}/storno`, stornoForm.value, idem())) as any
    stornoVisible.value = false
    ElMessage.success(`Создан и проведён ${st.number}`)
    await router.push(`/accounting/documents/${st.id}`)
  } catch (e) { showError(e) }
  busy.value = false
}

watch(() => route.params.id, () => { if (route.path.startsWith('/accounting/documents')) load() })

onMounted(async () => {
  await loadRefs()
  await load()
})
</script>

<style scoped>
.num { font-weight: 400; margin-left: 8px; color: #606266; }
.ver { font-size: 13px; font-weight: 400; color: #909399; margin-left: 8px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.head-form :deep(.el-form-item) { margin-bottom: 10px; }
.card-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.totals { font-size: 14px; color: #606266; }
.lines { overflow-x: auto; }
.line { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid #f0f0f0; min-width: 900px; }
.line.head { font-size: 12px; color: #909399; font-weight: 600; border-bottom: 1px solid #e4e7ed; }
.c-no { width: 28px; padding-top: 4px; color: #909399; }
.c-side { flex: 1 1 0; min-width: 220px; }
.c-side.wide { flex: 2 1 0; }
.c-dc { width: 110px; }
.c-amt { width: 140px; }
.c-memo { flex: 1 1 0; min-width: 140px; }
.c-led { width: 100px; }
.c-del { width: 32px; }
.sub { margin-top: 4px; }
.sub.cur { display: flex; gap: 4px; }
.amt :deep(input) { text-align: right; }
.hint { color: #909399; font-size: 12px; margin-left: 10px; }
.entry-meta { color: #909399; font-size: 12px; margin-bottom: 6px; }
</style>
