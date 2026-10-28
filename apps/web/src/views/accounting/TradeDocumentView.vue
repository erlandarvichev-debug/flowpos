<template>
  <div v-loading="loading" @keydown="onKey">
    <div class="page-header">
      <h1>
        {{ tl(docType) }}
        <span v-if="doc.number" class="num">№ {{ doc.number }}</span>
        <el-tag v-if="doc.status" :type="STATUS_TYPES[doc.status] as any" style="margin-left: 8px;">{{ t(doc.status) }}</el-tag>
        <el-tag v-if="isSaved && doc.status === 'POSTED'" :type="doc.entry || doc.costEntries?.length ? 'success' : doc.issue ? 'danger' : 'info'" style="margin-left: 6px;" effect="plain">
          {{ t('accountingCol') }}: {{ doc.entry || doc.costEntries?.length ? t('REFLECTED') : doc.issue ? t('ISSUE') : t('NONE') }}
        </el-tag>
      </h1>
      <div class="actions">
        <el-button @click="router.push('/accounting/trade')">{{ t('toList') }}</el-button>
        <template v-if="!readonly">
          <el-button type="primary" plain :loading="busy" @click="save()" v-if="org.can('acc.doc.write')">{{ t('save') }}</el-button>
          <el-button type="success" :loading="busy" @click="post" v-if="org.can('acc.doc.post') && doc.status !== 'POSTED'">{{ t('post') }}</el-button>
        </template>
        <el-dropdown v-if="isSaved" @command="onCommand" trigger="click">
          <el-button>Ещё <el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="tt in baseTargets" :key="tt" :command="`based:${tt}`">{{ t('createBased') }}: {{ tl(tt) }}</el-dropdown-item>
              <el-dropdown-item v-if="doc.status === 'POSTED' && org.can('acc.doc.post')" command="unpost" :divided="baseTargets.length > 0">{{ t('unpost') }}</el-dropdown-item>
              <el-dropdown-item v-if="doc.status !== 'CANCELLED' && org.can('acc.doc.cancel')" command="cancel" divided>{{ t('cancel') }}</el-dropdown-item>
              <el-dropdown-item v-if="(doc.status === 'CANCELLED' || doc.deleted) && org.can('acc.doc.cancel')" command="restore" divided>Восстановить</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <el-alert v-if="doc.issue" type="error" :closable="false" show-icon style="margin-bottom: 12px;" :title="`${t('autopilotIssue')}: ${doc.issue.message}`">
      <template #default>
        <div v-if="doc.issue.fix">{{ doc.issue.fix }}</div>
        <el-button size="small" type="danger" plain style="margin-top: 6px;" :loading="busy" @click="retry" v-if="org.can('acc.doc.post')">{{ t('retry') }}</el-button>
      </template>
    </el-alert>
    <el-alert v-if="doc.status === 'POSTED' && !readonly" type="warning" :closable="false" show-icon style="margin-bottom: 12px;"
      title="Документ проведён. Изменения сохранятся с указанием причины и сразу перепроведутся в учёте (с пересчётом себестоимости)." />
    <el-alert v-if="isExternal" type="info" :closable="false" show-icon style="margin-bottom: 12px;"
      :title="`Документ получен из обмена (${doc.owner}). Изменяйте его в системе-источнике — здесь только просмотр и отражение в учёте.`" />

    <el-card style="margin-bottom: 12px;">
      <el-form label-width="150px" class="head-form">
        <el-form-item :label="t('date')">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :disabled="readonly" :clearable="false" />
        </el-form-item>
        <el-form-item v-if="needsCounterparty" :label="t('counterparty')">
          <div style="width: 420px;"><DimSelect dim="COUNTERPARTY" v-model="form.counterpartyId" :selected-label="doc?.counterparty?.name" size="default" :disabled="readonly" /></div>
          <span v-if="doc.counterparty && form.counterpartyId === doc.counterparty.id" class="hint">{{ doc.counterparty.name }}{{ doc.counterparty.inn ? ` · ${doc.counterparty.inn}` : '' }}</span>
        </el-form-item>
        <el-form-item :label="docType === 'MOVE' ? 'Склад-отправитель' : t('store')">
          <el-select v-model="form.storeId" filterable clearable :disabled="readonly" placeholder="Выберите склад" style="width: 320px;">
            <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="docType === 'MOVE'" :label="t('storeTo')">
          <el-select v-model="form.storeToId" filterable clearable :disabled="readonly" placeholder="Выберите склад-получатель" style="width: 320px;">
            <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="hasPrices" :label="t('vatIncluded')">
          <el-switch v-model="form.vatIncluded" :disabled="readonly" />
        </el-form-item>
        <el-form-item v-if="isRetail" :label="t('paymentType')">
          <el-radio-group v-model="form.paymentType" :disabled="readonly">
            <el-radio-button value="CASH">{{ t('cashPay') }}</el-radio-button>
            <el-radio-button value="CARD">{{ t('cardPay') }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="docType === 'LOSS'" :label="t('lossAccount')">
          <div style="width: 360px;"><AccountSelect v-model="form.lossAccount" :accounts="accounts" /></div>
        </el-form-item>
        <el-form-item :label="t('comment')">
          <el-input v-model="form.comment" :disabled="readonly" style="max-width: 600px;" />
        </el-form-item>
        <el-form-item v-if="doc.status === 'POSTED' && !readonly" :label="t('reason')" required>
          <el-input v-model="form.reason" placeholder="Причина изменения проведённого документа" style="max-width: 600px;" />
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <template #header>
        <div class="card-head">
          <span>{{ t('lines') }}</span>
          <span class="totals" v-if="hasPrices">{{ t('total') }}: <b>{{ fmtMoney(total) }}</b> ₸</span>
        </div>
      </template>
      <div class="lines" ref="linesEl">
        <div class="line head">
          <div class="c-no">№</div><div class="c-prod">{{ t('product') }}</div><div class="c-num">{{ t('qty') }}</div>
          <template v-if="hasPrices">
            <div class="c-num">{{ t('price') }}</div><div class="c-pct">{{ t('discount') }}</div><div class="c-pct">{{ t('vatRate') }}</div><div class="c-sum">{{ t('amount') }}</div>
          </template>
          <div class="c-del"></div>
        </div>
        <div v-for="(l, i) in form.lines" :key="l.key" class="line">
          <div class="c-no">{{ i + 1 }}</div>
          <div class="c-prod">
            <el-select v-model="l.productId" filterable remote clearable :remote-method="searchProducts" :loading="prodLoading"
              size="small" style="width: 100%;" :disabled="readonly" placeholder="Начните вводить название или код" @visible-change="(o: boolean) => o && !productOptions.length && searchProducts('')">
              <el-option v-for="p in mergedProducts(l)" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
          </div>
          <div class="c-num"><el-input v-model="l.qty" size="small" class="nav-field num-in" :disabled="readonly" placeholder="0" /></div>
          <template v-if="hasPrices">
            <div class="c-num"><el-input v-model="l.price" size="small" class="nav-field num-in" :disabled="readonly" placeholder="0.00" /></div>
            <div class="c-pct"><el-input v-model="l.discount" size="small" class="nav-field num-in" :disabled="readonly" /></div>
            <div class="c-pct"><el-input v-model="l.vatRate" size="small" class="nav-field num-in" :disabled="readonly" :placeholder="t('vatDefault')" /></div>
            <div class="c-sum">{{ fmtMoney(lineTotal(l.qty, l.price, l.discount)) }}</div>
          </template>
          <div class="c-del"><el-button v-if="!readonly" link type="danger" :icon="Delete" @click="form.lines.splice(i, 1)" /></div>
        </div>
      </div>
      <div style="margin-top: 10px;" v-if="!readonly">
        <el-button :icon="Plus" size="small" @click="addLine">{{ t('addLine') }}</el-button>
        <span class="hint">Ctrl+Enter — новая строка, Enter — следующее поле, Ctrl+S — сохранить</span>
      </div>
    </el-card>

    <el-card v-if="isSaved" style="margin-top: 12px;">
      <el-tabs>
        <el-tab-pane :label="`${t('postings')} (${doc.entry?.postings?.length || 0})`">
          <div v-if="doc.entry" class="entry-meta">Правило {{ doc.entry.ruleCode }} v{{ doc.entry.ruleVersion }}</div>
          <PostingsTable :postings="doc.entry?.postings || []" empty="Нет проводок (документ не проведён или без бухгалтерских последствий)" />
        </el-tab-pane>
        <el-tab-pane :label="`${t('cost')} (${costPostings.length})`">
          <PostingsTable :postings="costPostings" empty="Себестоимость не рассчитывалась (нет складских расходов)" />
        </el-tab-pane>
        <el-tab-pane :label="`${t('related')} (${doc.related?.length || 0})`">
          <el-table :data="doc.related || []" size="small" empty-text="Нет связанных документов" @row-click="(r: any) => router.push(`/accounting/trade/${r.id}`)" style="cursor: pointer;">
            <el-table-column label="Связь" width="150"><template #default="{ row }">{{ row.id === doc.attributes?.baseId ? 'Основание' : 'Создан на основании' }}</template></el-table-column>
            <el-table-column :label="t('type')" min-width="160"><template #default="{ row }">{{ tl(row.docType) }}</template></el-table-column>
            <el-table-column :label="t('number')" prop="number" width="150" />
            <el-table-column :label="t('date')" width="110"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
            <el-table-column :label="t('amount')" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.total) }}</template></el-table-column>
            <el-table-column :label="t('status')" width="140"><template #default="{ row }"><el-tag size="small" :type="STATUS_TYPES[row.status] as any">{{ t(row.status) }}</el-tag></template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick, defineComponent, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Delete, ArrowDown } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElTable, ElTableColumn } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import AccountSelect from '@/components/accounting/AccountSelect.vue'
import DimSelect from '@/components/accounting/DimSelect.vue'
import { BASE_TARGETS, STATUS_TYPES, TRADE_TYPES, addMoney, fmtDate, fmtMoney, idem, lineTotal, loadDimOptions, normAmount, showError } from './acc'

const route = useRoute()
const router = useRouter()
const org = useOrgStore()
const { t, nm, lang } = useI18n()

/** Таблица проводок (документа или себестоимости). */
const PostingsTable = defineComponent({
  props: { postings: { type: Array, required: true }, empty: { type: String, default: '' } },
  setup(props) {
    return () => h(ElTable, { data: props.postings as any[], size: 'small', emptyText: props.empty }, () => [
      h(ElTableColumn, { label: 'Дт/Кт', width: 70 }, { default: ({ row }: any) => (row.side === 'D' ? 'Дт' : 'Кт') }),
      h(ElTableColumn, { label: 'Счёт', minWidth: 260 }, { default: ({ row }: any) => [h('b', row.account?.code), ' ', nm(row.account)] }),
      h(ElTableColumn, { label: 'Сумма', width: 150, align: 'right' }, { default: ({ row }: any) => fmtMoney(row.amount) }),
      h(ElTableColumn, { label: 'Кол-во', width: 100, align: 'right' }, { default: ({ row }: any) => row.quantity ?? '' }),
      h(ElTableColumn, { label: 'Содержание', minWidth: 180, showOverflowTooltip: true }, { default: ({ row }: any) => row.memo ?? '' }),
    ])
  },
})

const NO_PRICE = ['MOVE', 'LOSS']
const NO_COUNTERPARTY = ['ENTER', 'LOSS', 'MOVE', 'RETAIL_DEMAND', 'RETAIL_RETURN']

const loading = ref(false)
const busy = ref(false)
const doc = ref<any>({})
const stores = ref<any[]>([])
const accounts = ref<any[]>([])
const productOptions = ref<{ value: string; label: string }[]>([])
const prodLoading = ref(false)
const linesEl = ref<HTMLElement>()
let keySeq = 0

const emptyForm = () => ({
  date: dayjs().format('YYYY-MM-DD'), counterpartyId: undefined as string | undefined, storeId: undefined as string | undefined,
  storeToId: undefined as string | undefined, vatIncluded: true, paymentType: 'CASH', lossAccount: '7170', comment: '', reason: '',
  lines: [] as any[],
})
const form = ref<any>(emptyForm())

const isSaved = computed(() => !!doc.value.id)
const docType = computed<string>(() => doc.value.docType || (route.query.type as string) || 'SUPPLY')
const isExternal = computed(() => isSaved.value && doc.value.owner && doc.value.owner !== 'PLATFORM')
const readonly = computed(() => doc.value.status === 'CANCELLED' || !!isExternal.value || !org.can('acc.doc.write')
  || (doc.value.status === 'POSTED' && !org.can('acc.doc.post')))
const hasPrices = computed(() => !NO_PRICE.includes(docType.value))
const needsCounterparty = computed(() => !NO_COUNTERPARTY.includes(docType.value))
const isRetail = computed(() => docType.value.startsWith('RETAIL_'))
const baseTargets = computed(() => (doc.value.status === 'POSTED' || docType.value.endsWith('_ORDER') ? BASE_TARGETS[docType.value] || [] : []))
const total = computed(() => addMoney(form.value.lines.map((l: any) => lineTotal(l.qty, l.price, l.discount))))
const costPostings = computed(() => (doc.value.costEntries || []).flatMap((e: any) => e.postings))

const tl = (k: string) => (TRADE_TYPES[k] ? TRADE_TYPES[k][lang.value] : k)

function emptyLine() { return { key: ++keySeq, productId: undefined, productName: '', qty: '', price: '', discount: '', vatRate: '' } }

/** Варианты номенклатуры строки: найденные + текущий товар строки (чтобы показывалось название). */
function mergedProducts(l: any) {
  const list = [...productOptions.value]
  if (l.productId && !list.some((p) => p.value === l.productId)) list.unshift({ value: l.productId, label: l.productName || l.productId })
  return list
}

async function searchProducts(q: string) {
  prodLoading.value = true
  try { productOptions.value = await loadDimOptions('PRODUCT', q) } catch { productOptions.value = [] }
  prodLoading.value = false
}

const s = (v: any) => (v === null || v === undefined ? '' : String(v))

function fillForm(d: any) {
  const a = d.attributes || {}
  form.value = {
    date: String(d.date).slice(0, 10), counterpartyId: d.counterpartyId || undefined, storeId: d.storeId || undefined,
    storeToId: d.storeToId || undefined, vatIncluded: a.vatIncluded !== false, paymentType: a.paymentType || 'CASH',
    lossAccount: a.lossAccount || '7170', comment: d.comment || a.comment || '', reason: '',
    lines: (d.lines || []).map((l: any) => ({
      key: ++keySeq, productId: l.productId, productName: l.product ? `${l.product.code ? l.product.code + ' ' : ''}${l.product.name}` : '',
      qty: s(l.qty), price: s(l.price), discount: s(l.discount), vatRate: s(l.vatRate),
    })),
  }
}

function payload() {
  const lines = form.value.lines.filter((l: any) => l.productId).map((l: any) => {
    const o: any = { productId: l.productId, qty: normAmount(l.qty) }
    if (hasPrices.value) {
      o.price = normAmount(l.price) || '0'
      if (normAmount(l.discount)) o.discount = normAmount(l.discount)
      o.vatRate = normAmount(l.vatRate) || null
    }
    return o
  })
  const p: any = {
    date: form.value.date, comment: form.value.comment || undefined, storeId: form.value.storeId,
    counterpartyId: needsCounterparty.value ? form.value.counterpartyId : undefined, lines,
  }
  if (docType.value === 'MOVE') p.storeToId = form.value.storeToId
  if (hasPrices.value) p.vatIncluded = form.value.vatIncluded
  if (isRetail.value) p.paymentType = form.value.paymentType
  if (docType.value === 'LOSS') p.lossAccount = form.value.lossAccount
  return p
}

function addLine() {
  form.value.lines.push(emptyLine())
  nextTick(() => linesEl.value?.querySelector<HTMLInputElement>('.line:last-child input')?.focus())
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !readonly.value) { e.preventDefault(); addLine(); return }
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

async function load() {
  const id = route.params.id as string | undefined
  if (!id || id === 'new') {
    doc.value = {}
    form.value = { ...emptyForm(), lines: [emptyLine()] }
    if (stores.value.length === 1) form.value.storeId = stores.value[0].id
    return
  }
  loading.value = true
  try {
    doc.value = (await api.get(`/accounting/trade-documents/${id}`)) as any
    fillForm(doc.value)
  } catch (e) { showError(e) }
  loading.value = false
}

async function handleConflict(e: any) {
  if (e?.code !== 'VERSION_CONFLICT') return false
  try {
    await ElMessageBox.confirm(`${e.message}. Загрузить актуальную версию? Несохранённые изменения будут потеряны.`, 'Конфликт версий', { type: 'warning', confirmButtonText: 'Загрузить', cancelButtonText: 'Остаться' })
    await load()
  } catch { /* остаёмся */ }
  return true
}

async function save(silent = false): Promise<boolean> {
  if (doc.value.status === 'POSTED' && !form.value.reason) {
    ElMessage.warning('Укажите причину изменения проведённого документа')
    return false
  }
  busy.value = true
  try {
    if (!isSaved.value) {
      const created = (await api.post('/accounting/trade-documents', { docType: docType.value, ...payload(), status: 'DRAFT' }, idem())) as any
      if (!silent) ElMessage.success(`Сохранён ${created.number}`)
      await router.replace(`/accounting/trade/${created.id}`)
      doc.value = created
      fillForm(created)
    } else {
      doc.value = (await api.put(`/accounting/trade-documents/${doc.value.id}`, {
        ...payload(), expectedUpdatedAt: doc.value.updatedAt, reason: form.value.reason || undefined,
      }, idem())) as any
      fillForm(doc.value)
      if (!silent) ElMessage.success('Сохранено')
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
    doc.value = (await api.post(`/accounting/trade-documents/${doc.value.id}/post`, {}, idem())) as any
    fillForm(doc.value)
    ElMessage.success('Документ проведён и отражён в учёте')
  } catch (e: any) {
    showError(e)
    await load()
  }
  busy.value = false
}

async function action(path: string, msg: string) {
  busy.value = true
  try {
    doc.value = (await api.post(`/accounting/trade-documents/${doc.value.id}/${path}`, {}, idem())) as any
    fillForm(doc.value)
    ElMessage.success(msg)
  } catch (e) { showError(e) }
  busy.value = false
}

async function retry() {
  busy.value = true
  try {
    const r = (await api.post(`/accounting/autopilot/documents/${doc.value.id}/retry`)) as any
    if (r.status === 'ERROR') showError({ message: r.message })
    else ElMessage.success('Документ отражён в учёте')
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

async function onCommand(cmd: string) {
  if (cmd === 'unpost') return action('unpost', 'Проведение отменено')
  if (cmd === 'restore') return action('restore', 'Документ восстановлен')
  if (cmd === 'cancel') {
    try {
      await ElMessageBox.confirm('Документ будет помечен на удаление, отражение в учёте и остатки — отменены.', 'Пометка на удаление', { type: 'warning', confirmButtonText: 'Пометить', cancelButtonText: 'Отмена' })
    } catch { return }
    return action('cancel', 'Помечен на удаление')
  }
  if (cmd.startsWith('based:')) {
    busy.value = true
    try {
      const created = (await api.post(`/accounting/trade-documents/${doc.value.id}/create-based`, { docType: cmd.slice(6), date: dayjs().format('YYYY-MM-DD') }, idem())) as any
      ElMessage.success(`Создан ${created.number}`)
      await router.push(`/accounting/trade/${created.id}`)
    } catch (e) { showError(e) }
    busy.value = false
  }
}

watch(() => route.params.id, () => { if (route.path.startsWith('/accounting/trade')) load() })

onMounted(async () => {
  try {
    stores.value = (await api.get('/catalog/warehouses')) as any
    accounts.value = (await api.get('/accounting/chart')) as any
  } catch (e) { showError(e) }
  await load()
})
</script>

<style scoped>
.num { font-weight: 400; margin-left: 8px; color: #606266; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.head-form :deep(.el-form-item) { margin-bottom: 10px; }
.card-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.totals { font-size: 14px; color: #606266; }
.lines { overflow-x: auto; }
.line { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid #f0f0f0; min-width: 820px; }
.line.head { font-size: 12px; color: #909399; font-weight: 600; border-bottom: 1px solid #e4e7ed; }
.c-no { width: 28px; color: #909399; }
.c-prod { flex: 1 1 0; min-width: 260px; }
.c-num { width: 110px; }
.c-pct { width: 80px; }
.c-sum { width: 130px; text-align: right; font-variant-numeric: tabular-nums; }
.c-del { width: 32px; }
.num-in :deep(input) { text-align: right; }
.hint { color: #909399; font-size: 12px; margin-left: 10px; }
.entry-meta { color: #909399; font-size: 12px; margin-bottom: 6px; }
</style>
