<template>
  <div>
    <div class="page-header">
      <h1>{{ t('esf') }} <el-tag :type="settings?.environment === 'PROD' ? 'danger' : 'warning'" effect="plain" style="vertical-align: middle;">{{ settings?.environment === 'PROD' ? 'Боевая ИС ЭСФ' : 'Тестовый стенд КГД' }}</el-tag></h1>
      <div class="actions">
        <template v-if="settings?.session">
          <el-tag type="success">Вход в ИС ЭСФ: ИИН {{ settings.session.iin }}</el-tag>
          <el-button v-if="canSend" size="default" @click="logout">Выйти</el-button>
        </template>
        <el-button v-else-if="canSend" type="primary" :loading="busy.login" @click="login">Войти в ИС ЭСФ (ЭЦП)</el-button>
        <el-button :loading="busy.refresh" :disabled="!settings?.session" @click="refresh">Обновить статусы и входящие</el-button>
      </div>
    </div>

    <EsfHealth :health="health" />

    <el-row :gutter="12" style="margin-bottom: 12px;">
      <el-col :xs="12" :md="5"><el-card><el-statistic title="Реализации без ЭСФ" :value="summary?.pendingDocs ?? 0" /></el-card></el-col>
      <el-col :xs="12" :md="5"><el-card><el-statistic title="Готовы к подписи" :value="count('OUTBOUND', ['READY'])" /></el-card></el-col>
      <el-col :xs="12" :md="5"><el-card><el-statistic title="Отправлены / доставлены" :value="count('OUTBOUND', ['SENT', 'DELIVERED'])" /></el-card></el-col>
      <el-col :xs="12" :md="5"><el-card><el-statistic title="Отклонены ИС ЭСФ" :value="count('OUTBOUND', ['REJECTED'])" :value-style="{ color: count('OUTBOUND', ['REJECTED']) ? '#f56c6c' : undefined }" /></el-card></el-col>
      <el-col :xs="12" :md="4"><el-card><el-statistic title="Требуют исправления" :value="summary?.outdated ?? 0" :value-style="{ color: summary?.outdated ? '#e6a23c' : undefined }" /></el-card></el-col>
    </el-row>

    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;">
      ЭСФ формируются только из проведённых реализаций, отражённых в бухгалтерии: суммы и НДС берутся из тех же расчётов, что и проводки.
      Подпись ставится на вашем компьютере через NCALayer — ключ и пароль ЭЦП в FlowPOS не передаются.
    </el-alert>

    <el-tabs v-model="tab" @tab-change="onTab">
      <el-tab-pane v-for="lt in LIST_TABS" :key="lt.name" :label="lt.label" :name="lt.name" />

      <el-tab-pane label="Решения" name="DECISIONS">
        <el-card>
          <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;"
            title="Отзыв, отклонение, подтверждение и привязка основания исполняются только утверждённым решением. Получение документа (техническое подтверждение) согласием не является." />
          <el-table :data="decisions" size="small" empty-text="Решений нет">
            <el-table-column label="Решение" width="170"><template #default="{ row }">{{ KIND_TEXT[row.kind] ?? row.kind }}</template></el-table-column>
            <el-table-column prop="basis" label="Основание" min-width="200" />
            <el-table-column prop="reason" label="Причина" min-width="140" />
            <el-table-column label="Статус" width="130"><template #default="{ row }">{{ STATUS_TEXT[row.status] ?? row.status }}</template></el-table-column>
            <el-table-column label="Срок" width="150">
              <template #default="{ row }">
                <span v-if="row.dueAt" :style="{ color: row.overdue ? 'var(--el-color-danger)' : undefined }">{{ fmtDate(row.dueAt) }}{{ row.overdue ? ' — просрочено' : '' }}</span>
                <span v-else style="color: var(--el-text-color-secondary)">не задан</span>
              </template>
            </el-table-column>
            <el-table-column label="" width="260">
              <template #default="{ row }">
                <el-button v-if="row.status === 'PROPOSED' && org.can('acc.esf.approve')" size="small" link type="success" @click="approveDecision(row)">Утвердить</el-button>
                <el-button v-if="['PROPOSED', 'APPROVED'].includes(row.status)" size="small" link type="danger" @click="rejectDecision(row)">Отклонить</el-button>
                <el-button v-if="row.status === 'APPROVED' && canSend" size="small" link type="primary" :loading="row._busy" @click="executeDecision(row)">Исполнить</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="Настройки" name="SETTINGS">
        <EsfHealth :health="health && { ...health, alerts: [] }" detailed />
        <el-card v-if="form">
          <el-form label-width="290px" style="max-width: 820px;" :disabled="!org.can('acc.policy.manage')">
            <el-form-item label="Среда ИС ЭСФ">
              <el-radio-group v-model="form.environment">
                <el-radio value="TEST">Тестовый стенд (test3.esf.kgd.gov.kz)</el-radio>
                <el-radio value="PROD">Боевая (esf.gov.kz)</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="ИИН владельца ЭЦП">
              <el-input v-model="form.signerIin" maxlength="12" placeholder="12 цифр — тот, кто входит и подписывает" />
            </el-form-item>
            <el-form-item label="ФИО оператора (в ЭСФ)"><el-input v-model="form.operatorFullname" placeholder="По умолчанию — ФИО пользователя" /></el-form-item>
            <el-form-item label="Тип подписи">
              <el-radio-group v-model="form.signatureType">
                <el-radio value="COMPANY">ЭЦП юридического лица / ИП</el-radio>
                <el-radio value="OPERATOR">ЭЦП уполномоченного лица</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="Дата постановки на учёт по НДС (B 9)">
              <el-date-picker v-model="form.vatRegistrationDate" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" placeholder="Для плательщиков НДС" />
            </el-form-item>
            <el-form-item label="Способ отправления (E 29)">
              <el-select v-model="form.transportTypeCode" filterable allow-create clearable placeholder="Код вида транспорта" style="width: 320px;">
                <el-option v-for="o in TRANSPORT" :key="o.code" :value="o.code" :label="`${o.code} — ${o.name}`" />
              </el-select>
              <div class="hint">Классификатор видов транспорта (Решение Комиссии ТС № 378, приложение 3). Обязательная строка ЭСФ.</div>
            </el-form-item>
            <el-form-item label="Признак происхождения товаров (G 2)">
              <el-select v-model="form.defaultGoodsOrigin" clearable placeholder="Для товаров без своего признака" style="width: 100%;">
                <el-option v-for="o in ORIGIN" :key="o.code" :value="o.code" :label="`${o.code} — ${o.name}`" />
              </el-select>
              <div class="hint">Для работ и услуг всегда «6». Признаки 1 и 2 требуют данных декларации — такие ЭСФ пока выписываются в ИС ЭСФ вручную.</div>
            </el-form-item>
            <el-form-item label="Готовить ЭСФ автоматически">
              <el-switch v-model="form.autoPrepare" />
              <span class="hint" style="margin-left: 8px;">по каждой проведённой реализации; отправка — только после вашей подписи</span>
            </el-form-item>
            <el-form-item><el-button type="primary" :loading="busy.save" @click="save">Сохранить</el-button></el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>
    </el-tabs>
    <template v-if="LIST_TAB_NAMES.includes(tab)">
      <el-card v-if="tab === 'OUTBOUND' && pending.length" style="margin-bottom: 12px;">
        <template #header>
          <div class="card-head">
            <span>Реализации и возвраты без ЭСФ</span>
            <el-button v-if="canSend" size="small" type="primary" plain :loading="busy.prepareAll" @click="prepareAll">Сформировать все ({{ pending.length }})</el-button>
          </div>
        </template>
        <el-table :data="pending" size="small" aria-label="Реализации без ЭСФ">
          <el-table-column label="Дата" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
          <el-table-column label="Документ" width="160"><template #default="{ row }"><el-link type="primary" @click="router.push(`/accounting/trade/${row.id}`)">{{ row.docType === 'SALES_RETURN' ? 'Возврат' : 'Реализация' }} {{ row.number }}</el-link></template></el-table-column>
          <el-table-column label="Покупатель" min-width="200"><template #default="{ row }">{{ row.counterparty }} <span class="muted">{{ row.counterpartyTin }}</span></template></el-table-column>
          <el-table-column label="Сумма" width="130" align="right"><template #default="{ row }">{{ fmtMoney(row.total) }}</template></el-table-column>
          <el-table-column width="140"><template #default="{ row }"><el-button v-if="canSend" size="small" :loading="row._busy" @click="prepare(row)">Сформировать</el-button></template></el-table-column>
        </el-table>
      </el-card>

      <el-card>
        <template #header>
          <form class="filters" role="search" aria-label="Фильтры ЭСФ" @submit.prevent="load">
            <el-input v-model="filters.search" placeholder="№, рег. номер, БИН, контрагент" clearable aria-label="Поиск" style="width: 240px;" @keyup.enter="load" @clear="load" />
            <el-date-picker v-model="filters.period" type="daterange" value-format="YYYY-MM-DD" start-placeholder="С" end-placeholder="По" aria-label="Период выписки" style="width: 240px;" @change="load" />
            <el-select v-model="filters.status" multiple collapse-tags clearable placeholder="Статус" aria-label="Статус" style="width: 190px;" @change="load">
              <el-option v-for="(v, k) in STATUS" :key="k" :label="v[0]" :value="k" />
            </el-select>
            <el-select v-model="filters.invoiceType" clearable placeholder="Вид" aria-label="Вид ЭСФ" style="width: 150px;" @change="load">
              <el-option label="Основной" value="ORDINARY_INVOICE" /><el-option label="Исправленный" value="FIXED_INVOICE" /><el-option label="Дополнительный" value="ADDITIONAL_INVOICE" />
            </el-select>
            <el-input v-if="tab === 'ERRORS'" v-model="filters.errorCode" placeholder="Код ошибки" clearable aria-label="Код ошибки" style="width: 170px;" @keyup.enter="load" @clear="load" />
            <el-button native-type="submit">Найти</el-button>
            <el-button v-if="hasFilters" link @click="clearFilters">Сбросить</el-button>
            <span class="spacer" />
            <el-button v-if="tab === 'OUTBOUND' && canSend" type="success" :disabled="!selected.length" :loading="busy.send" @click="send">Подписать и отправить ({{ selected.length }})</el-button>
          </form>
        </template>
        <p v-if="tab === 'NEEDS_DECISION'" class="muted hint">Ждут подтверждения получателя, результата сверки (UNKNOWN), исправления после изменения документа или привязки основания.</p>
        <p v-if="tab === 'ERRORS'" class="muted hint">Отклонены ИС ЭСФ (ФЛК), ошибочные и с неизвестным результатом. UNKNOWN не отправляется повторно вслепую — сначала сверка.</p>
        <el-table :data="items" size="small" v-loading="loading" :aria-label="LIST_TABS.find((x) => x.name === tab)?.label" @selection-change="(r: any[]) => (selected = r)" :empty-text="EMPTY[tab]">
          <el-table-column v-if="tab === 'OUTBOUND'" type="selection" width="40" :selectable="(r: any) => r.status === 'READY'" />
          <el-table-column label="№" width="150">
            <template #default="{ row }">
              <el-button link type="primary" :aria-label="`Открыть ЭСФ № ${row.num}`" @click="cardId = row.id">{{ row.num }}</el-button>
              <el-tag v-if="row.invoiceType !== 'ORDINARY_INVOICE'" size="small" effect="plain">{{ TYPE[row.invoiceType] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="tab !== 'OUTBOUND' && tab !== 'INBOUND'" label="Напр." width="70"><template #default="{ row }">{{ row.direction === 'INBOUND' ? 'вх.' : 'исх.' }}</template></el-table-column>
          <el-table-column label="Выписан" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
          <el-table-column :label="tab === 'INBOUND' ? 'Поставщик' : tab === 'OUTBOUND' ? 'Получатель' : 'Контрагент'" min-width="160">
            <template #default="{ row }">{{ row.direction === 'INBOUND' ? row.sellerName : row.customerName }} <span class="muted">{{ row.direction === 'INBOUND' ? row.sellerTin : row.customerTin }}</span></template>
          </el-table-column>
          <el-table-column label="НДС" width="110" align="right"><template #default="{ row }">{{ fmtMoney(row.totalNds) }}</template></el-table-column>
          <el-table-column label="Всего" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.totalWithTax) }}</template></el-table-column>
          <el-table-column label="Статус" min-width="170">
            <template #default="{ row }">
              <el-tag size="small" :type="statusType(row)">{{ statusLabel(row) }}</el-tag>
              <el-tag v-if="row.outdated" size="small" type="warning" style="margin-left: 4px;">исправить</el-tag>
              <el-tag v-if="row.direction === 'INBOUND' && !row.sourceDocId && row.suggestedSourceDocId" size="small" effect="plain" style="margin-left: 4px;">основание?</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="Ошибка" min-width="180" v-if="tab === 'ERRORS'"><template #default="{ row }"><span class="err">{{ row.errors?.[0]?.text || row.errors?.[0]?.errorCode || '' }}</span></template></el-table-column>
          <el-table-column label="Рег. номер" min-width="170" v-else><template #default="{ row }"><span class="mono">{{ row.registrationNumber }}</span></template></el-table-column>
          <el-table-column label="Действия" width="200" fixed="right">
            <template #default="{ row }">
              <el-button v-if="canSend && row.direction === 'OUTBOUND' && ['READY', 'REJECTED'].includes(row.status)" size="small" link type="danger" @click="discard(row)">Отменить</el-button>
              <el-button v-if="canSend && row.direction === 'OUTBOUND' && canRevoke(row)" size="small" link type="danger" @click="act('REVOKE', row)">Отозвать</el-button>
              <el-button v-if="row.status === 'UNKNOWN'" size="small" link type="warning" :loading="busy.refresh" :disabled="!settings?.session" @click="reconcile">Сверить статус</el-button>
              <template v-if="canSend && row.direction === 'INBOUND' && waiting(row) === 'CONFIRM'">
                <el-button size="small" link type="success" @click="act('APPROVE', row)">Подтвердить</el-button>
                <el-button size="small" link type="danger" @click="act('DECLINE', row)">Отклонить</el-button>
              </template>
              <el-button v-if="canSend && row.direction === 'INBOUND' && waiting(row) === 'REVOKE'" size="small" link type="warning" @click="act('CONFIRM_REVOKE', row)">Подтвердить отзыв</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <EsfCard :id="cardId" :can-send="canSend" :busy="busy.refresh" :reload-key="cardReload" @close="cardId = null" @open="(id: string) => (cardId = id)" @reconcile="reconcile" @release="releaseUnknown" />
    <BulkResult :open="bulk.open" :title="bulk.title" :rows="bulk.rows" :effect="bulk.effect" @close="bulk.open = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { fmtDate, fmtMoney, showError } from './acc'
import { NCALAYER_DOWNLOAD, NcaLayerError, signAuthXml, signRaw } from '@/utils/ncalayer'
import EsfCard from './esf/EsfCard.vue'
import EsfHealth from './esf/EsfHealth.vue'
import { STATUS } from './esf/status'
import BulkResult, { type BulkRow } from './esf/BulkResult.vue'

const router = useRouter()
const org = useOrgStore()
const { t } = useI18n()
const canSend = computed(() => org.can('acc.esf.send'))
const tab = ref('OUTBOUND')
const loading = ref(false)
const busy = reactive({ login: false, refresh: false, send: false, save: false, prepareAll: false })
const settings = ref<any>(null)
const summary = ref<any>(null)
const health = ref<any>(null)
const items = ref<any[]>([])
const pending = ref<any[]>([])
const selected = ref<any[]>([])
const decisions = ref<any[]>([])
const form = ref<any>(null)
// FP-020: вкладки рабочего места, фильтры, карточка, итог массовых действий
const LIST_TABS = [
  { name: 'OUTBOUND', label: 'Исходящие' },
  { name: 'INBOUND', label: 'Входящие' },
  { name: 'NEEDS_DECISION', label: 'Требуют решения' },
  { name: 'ERRORS', label: 'Ошибки' },
]
const LIST_TAB_NAMES = LIST_TABS.map((x) => x.name)
const EMPTY: Record<string, string> = {
  OUTBOUND: 'Исходящих ЭСФ нет',
  INBOUND: 'Входящих ЭСФ нет. Войдите в ИС ЭСФ и нажмите «Обновить» — FlowPOS загрузит новые ЭСФ поставщиков.',
  NEEDS_DECISION: 'Решений не требуется',
  ERRORS: 'Ошибок нет',
}
const filters = reactive<{ search: string; period: string[] | null; status: string[]; invoiceType: string; errorCode: string }>({ search: '', period: null, status: [], invoiceType: '', errorCode: '' })
const hasFilters = computed(() => !!(filters.search || filters.period?.length || filters.status.length || filters.invoiceType || filters.errorCode))
const cardId = ref<string | null>(null)
const cardReload = ref(0)
const bulk = reactive<{ open: boolean; title: string; rows: BulkRow[]; effect?: string }>({ open: false, title: '', rows: [] })
function clearFilters() {
  Object.assign(filters, { search: '', period: null, status: [], invoiceType: '', errorCode: '' })
  load()
}
function onTab() {
  selected.value = []
  load()
}
function listParams() {
  const p: Record<string, string | number> = { limit: 200 }
  if (tab.value === 'OUTBOUND' || tab.value === 'INBOUND') p.direction = tab.value
  else p.view = tab.value
  if (filters.search) p.search = filters.search
  if (filters.period?.length === 2) { p.from = filters.period[0]; p.to = filters.period[1] }
  if (filters.status.length) p.status = filters.status.join(',')
  if (filters.invoiceType) p.invoiceType = filters.invoiceType
  if (filters.errorCode && tab.value === 'ERRORS') p.errorCode = filters.errorCode
  return p
}

// Правила выписки счета-фактуры, п. 38 (графа 2)
const ORIGIN = [
  { code: '1', name: 'товар из Перечня (ввезён из третьих стран / ЕАЭС)' },
  { code: '2', name: 'ввезённый товар, не включённый в Перечень' },
  { code: '3', name: 'произведён в РК, код ТН ВЭД включён в Перечень' },
  { code: '4', name: 'произведён в РК, код ТН ВЭД не включён в Перечень' },
  { code: '5', name: 'прочие товары (не 1–4), здания, сооружения, земля' },
]
const TRANSPORT = [
  { code: '10', name: 'морской' }, { code: '20', name: 'железнодорожный' }, { code: '30', name: 'автодорожный' },
  { code: '40', name: 'воздушный' }, { code: '50', name: 'почтовое отправление' }, { code: '71', name: 'трубопроводный' },
  { code: '72', name: 'линии электропередачи' }, { code: '80', name: 'внутренний водный' }, { code: '90', name: 'своим ходом' },
]
const TYPE: Record<string, string> = { ADDITIONAL_INVOICE: 'доп.', FIXED_INVOICE: 'испр.' }
const st = (r: any) => r.esfStatus || r.status
const canRevoke = (r: any) => r.invoiceType === 'ORDINARY_INVOICE' && r.registrationNumber && ['SENT', 'CREATED', 'DELIVERED'].includes(r.status) && !['REVOKED', 'WAITING_CUSTOMER_REVOKE_CONFIRMATION', 'CANCELED'].includes(r.esfStatus ?? '')
const waiting = (r: any) => st(r) === 'WAITING_CUSTOMER_CONFIRMATION' && r.invoiceType !== 'ORDINARY_INVOICE' ? 'CONFIRM' : st(r) === 'WAITING_CUSTOMER_REVOKE_CONFIRMATION' ? 'REVOKE' : null
const statusLabel = (r: any) => STATUS[r.esfStatus && r.status === 'SENT' ? r.esfStatus : r.status]?.[0] ?? r.esfStatus ?? r.status
const statusType = (r: any) => (STATUS[r.esfStatus && r.status === 'SENT' ? r.esfStatus : r.status]?.[1] ?? '') as any
const count = (dir: string, st: string[]) => (summary.value?.counts ?? []).filter((c: any) => c.direction === dir && st.includes(c.status)).reduce((a: number, c: any) => a + c.count, 0)

function ncaError(e: any) {
  if (e instanceof NcaLayerError) {
    if (e.code === 'CANCELED') return ElMessage.info('Подпись отменена')
    if (e.code === 'NOT_RUNNING') {
      return ElMessageBox.confirm('NCALayer не запущен или не установлен. Запустите NCALayer (значок в трее) и повторите.', 'Нужен NCALayer', { confirmButtonText: 'Скачать NCALayer', cancelButtonText: 'Закрыть', type: 'warning' })
        .then(() => window.open(NCALAYER_DOWNLOAD, '_blank')).catch(() => undefined)
    }
    return showError({ message: `NCALayer: ${e.message}` })
  }
  showError(e)
}

async function load() {
  loading.value = true
  try {
    settings.value = await api.get('/accounting/esf/settings')
    summary.value = await api.get('/accounting/esf/summary')
    health.value = await api.get('/accounting/esf/health').catch(() => null)
    if (tab.value === 'SETTINGS') {
      const s = settings.value
      form.value = { environment: s.environment, signerIin: s.signerIin ?? '', operatorFullname: s.operatorFullname ?? '', signatureType: s.signatureType, vatRegistrationDate: s.vatRegistrationDate ? String(s.vatRegistrationDate).slice(0, 10) : null, transportTypeCode: s.transportTypeCode ?? '', defaultGoodsOrigin: s.defaultGoodsOrigin ?? '', autoPrepare: s.autoPrepare }
    } else if (tab.value === 'DECISIONS') {
      decisions.value = (await api.get('/accounting/esf/decisions')) as any
    } else {
      const r = (await api.get('/accounting/esf/invoices', { params: listParams() })) as any
      items.value = r.items
      pending.value = tab.value === 'OUTBOUND' ? r.pending : []
    }
  } catch (e) { showError(e) }
  loading.value = false
}

async function login() {
  busy.login = true
  try {
    const { ticket } = (await api.post('/accounting/esf/session/ticket')) as any
    const signedTicket = await signAuthXml(ticket)
    await api.post('/accounting/esf/session', { signedTicket })
    ElMessage.success('Вход в ИС ЭСФ выполнен')
    await load()
  } catch (e) { ncaError(e) }
  busy.login = false
}

async function logout() {
  try { await api.post('/accounting/esf/session/close') } catch (e) { showError(e) }
  await load()
}

/** UNKNOWN: сверка по дате и номеру — то же обновление статусов; карточка перечитывается. */
async function reconcile() {
  await refresh()
  cardReload.value++
}

async function refresh() {
  busy.refresh = true
  try {
    const r = (await api.post('/accounting/esf/refresh')) as any
    ElMessage.success(`Статусов обновлено: ${r.updated}, новых входящих: ${r.inbound}`)
    await load()
  } catch (e) { showError(e); await load() }
  busy.refresh = false
}

async function prepare(row: any) {
  row._busy = true
  try { await api.post(`/accounting/esf/prepare/${row.id}`); await load() } catch (e) { showError(e) }
  row._busy = false
}

async function prepareAll() {
  busy.prepareAll = true
  const rows: BulkRow[] = []
  for (const row of [...pending.value]) {
    const label = `${row.docType === 'SALES_RETURN' ? 'Возврат' : 'Реализация'} ${row.number}`
    try { await api.post(`/accounting/esf/prepare/${row.id}`); rows.push({ label, outcome: 'OK' }) } catch (e: any) { rows.push({ label, outcome: 'FAILED', message: e?.fix || e?.message }) }
  }
  busy.prepareAll = false
  await load()
  Object.assign(bulk, { open: true, title: 'Формирование ЭСФ', rows, effect: undefined })
}

async function send() {
  if (!settings.value?.session) return showError({ message: 'Нет входа в ИС ЭСФ', fix: 'Нажмите «Войти в ИС ЭСФ» и подпишите вход ключом ЭЦП.' })
  busy.send = true
  try {
    const sd = (await api.post('/accounting/esf/sign-data', { ids: selected.value.map((r) => r.id) })) as any
    const { certificate, signatures } = await signRaw(sd.items.map((i: any) => i.body))
    const r = (await api.post('/accounting/esf/upload', { certificate, items: sd.items.map((i: any, k: number) => ({ id: i.id, signature: signatures[k], signingToken: i.signingToken })) })) as any
    // Итог по каждому ЭСФ: принято / отклонено / неизвестно — частичный успех не прячется за одним «успешно».
    const rows: BulkRow[] = (r.items ?? []).map((i: any) => ({
      label: `№ ${i.num}`,
      outcome: i.status === 'UNKNOWN' ? 'UNKNOWN' : i.status === 'SENT' ? 'OK' : 'FAILED',
      message: i.fenced ? 'Результат не применён: ЭСФ перехвачен сверкой' : (i.errors ?? []).map((e: any) => e.text || e.errorCode).join('; '),
    }))
    Object.assign(bulk, { open: true, title: 'Отправка ЭСФ', rows, effect: `Принято ИС ЭСФ: ${r.accepted}, отклонено: ${r.declined}, результат неизвестен: ${r.unknown}${r.unknown ? ' — дождитесь сверки, повторно вслепую не отправляйте' : ''}` })
    selected.value = []
    await load()
  } catch (e) { ncaError(e); await load() }
  busy.send = false
}

const ACT_TEXT: Record<string, { title: string; ask?: string; ok: string }> = {
  REVOKE: { title: 'Отзыв ЭСФ', ask: 'Причина отзыва', ok: 'Отзыв отправлен в ИС ЭСФ' },
  DECLINE: { title: 'Отклонение ЭСФ', ask: 'Причина отклонения', ok: 'ЭСФ отклонён' },
  APPROVE: { title: 'Подтверждение ЭСФ', ok: 'ЭСФ подтверждён' },
  CONFIRM_REVOKE: { title: 'Подтверждение отзыва', ok: 'Отзыв подтверждён' },
}

const KIND_TEXT: Record<string, string> = { REVOKE: 'Отзыв', DECLINE: 'Отклонение', APPROVE: 'Подтверждение', CONFIRM_REVOKE: 'Подтверждение отзыва', LINK_BASIS: 'Привязка основания' }
const STATUS_TEXT: Record<string, string> = { PROPOSED: 'Ждёт утверждения', APPROVED: 'Утверждено', EXECUTING: 'Исполняется', EXECUTED: 'Исполнено', REJECTED: 'Отклонено', STALE: 'Устарело', FAILED: 'Ошибка' }

/**
 * FP-018: отзыв/отклонение/подтверждение — решением: причина и основание → предложить → утвердить
 * (если можно самому; иначе ждёт другого утверждающего) → подпись в NCALayer → исполнение.
 */
async function act(action: string, row: any) {
  if (!settings.value?.session) return showError({ message: 'Нет входа в ИС ЭСФ', fix: 'Нажмите «Войти в ИС ЭСФ» и подпишите вход ключом ЭЦП.' })
  const txt = ACT_TEXT[action]
  let reason: string | undefined
  let basis = ''
  try {
    if (txt.ask) reason = ((await ElMessageBox.prompt(`ЭСФ № ${row.num}. ${txt.ask}:`, txt.title, { confirmButtonText: 'Далее', cancelButtonText: 'Отмена', inputValidator: (v: string) => !!v?.trim() || 'Укажите причину' })) as any).value
    basis = ((await ElMessageBox.prompt(`ЭСФ № ${row.num}. Основание решения — что проверено (документ, переписка, сверка):`, txt.title, { confirmButtonText: 'Предложить решение', cancelButtonText: 'Отмена', inputValidator: (v: string) => (v?.trim().length ?? 0) >= 5 || 'Не короче 5 символов' })) as any).value
  } catch { return }
  row._busy = true
  try {
    const d = (await api.post('/accounting/esf/decisions', { kind: action, ids: [row.id], reason, basis })) as any
    if (!org.can('acc.esf.approve')) {
      ElMessage.info('Решение предложено — его утвердит главный бухгалтер или руководитель (вкладка «Решения»)')
    } else {
      try {
        await api.post(`/accounting/esf/decisions/${d.id}/approve`, {})
      } catch (e: any) {
        if (e?.response?.data?.code === 'ESF_FOUR_EYES') {
          ElMessage.info('Решение предложено — его утвердит другой сотрудник (вкладка «Решения»)')
          await load()
          row._busy = false
          return
        }
        throw e
      }
      await signAndExecute(d.id, txt.ok)
    }
    await load()
  } catch (e) { ncaError(e) }
  row._busy = false
}

async function signAndExecute(id: string, ok = 'Решение исполнено') {
  const data = (await api.post(`/accounting/esf/decisions/${id}/sign-data`)) as any
  const { certificate, signatures } = await signRaw([data.data])
  const r = (await api.post(`/accounting/esf/decisions/${id}/execute`, { signature: signatures[0], certificate, signingToken: data.signingToken })) as any
  if (r.status === 'EXECUTED') ElMessage.success(ok)
  else showError({ message: `ИС ЭСФ не выполнила операцию: ${r.items?.[0]?.error ?? ''}` })
}

async function approveDecision(row: any) {
  try { await api.post(`/accounting/esf/decisions/${row.id}/approve`, {}); await load() } catch (e) { showError(e) }
}

async function rejectDecision(row: any) {
  let note = ''
  try { note = ((await ElMessageBox.prompt('Почему решение отклонено?', 'Отклонить решение', { confirmButtonText: 'Отклонить', cancelButtonText: 'Отмена', inputValidator: (v: string) => (v?.trim().length ?? 0) >= 5 || 'Не короче 5 символов' })) as any).value } catch { return }
  try { await api.post(`/accounting/esf/decisions/${row.id}/reject`, { note }); await load() } catch (e) { showError(e) }
}

async function executeDecision(row: any) {
  if (!settings.value?.session) return showError({ message: 'Нет входа в ИС ЭСФ', fix: 'Нажмите «Войти в ИС ЭСФ» и подпишите вход ключом ЭЦП.' })
  row._busy = true
  try {
    if (row.kind === 'LINK_BASIS') { await api.post(`/accounting/esf/decisions/${row.id}/execute`, {}); ElMessage.success('Основание привязано') }
    else await signAndExecute(row.id)
    await load()
  } catch (e) { ncaError(e) }
  row._busy = false
}

async function discard(row: any) {
  try { await ElMessageBox.confirm(`Отменить ЭСФ № ${row.num}? Он не был зарегистрирован в ИС ЭСФ.`, 'Отмена ЭСФ', { type: 'warning', confirmButtonText: 'Отменить ЭСФ', cancelButtonText: 'Нет' }) } catch { return }
  try { await api.post(`/accounting/esf/invoices/${row.id}/discard`); await load() } catch (e) { showError(e) }
}

/** UNKNOWN: ЭСФ мог быть принят. Повтор — только если сверка по дате и номеру его не нашла (проверяет сервер). */
async function releaseUnknown(row: any) {
  let reason = ''
  try {
    reason = ((await ElMessageBox.prompt(`ЭСФ № ${row.num}: ответ ИС ЭСФ не был получен. Повторная отправка допустима, только если сверка не нашла этот ЭСФ в ИС ЭСФ. Причина:`, 'Повторная отправка', { confirmButtonText: 'Разрешить', cancelButtonText: 'Отмена', inputValidator: (v: string) => (v?.trim().length ?? 0) >= 5 || 'Не короче 5 символов' })) as any).value
  } catch { return }
  try { await api.post(`/accounting/esf/invoices/${row.id}/release-unknown`, { reason }); ElMessage.success('ЭСФ снова готов к подписи'); cardReload.value++; await load() } catch (e) { showError(e) }
}

async function save() {
  busy.save = true
  try {
    settings.value = await api.put('/accounting/esf/settings', form.value)
    ElMessage.success('Настройки ЭСФ сохранены')
  } catch (e) { showError(e) }
  busy.save = false
}

onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.muted { color: #909399; font-size: 12px; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.hint { color: #909399; font-size: 12px; line-height: 1.4; margin-top: 4px; }
.errors { color: #f56c6c; font-size: 13px; padding: 4px 12px; }
.warn { color: #e6a23c; font-size: 13px; padding: 4px 12px; }
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.err { color: #f56c6c; font-size: 12px; }
/* Видимый фокус для работы с клавиатуры (FP-020). */
:deep(.el-button:focus-visible), :deep(.el-link:focus-visible), :deep(.el-input__wrapper.is-focus) { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
</style>
