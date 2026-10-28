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

    <el-tabs v-model="tab" @tab-change="load">
      <el-tab-pane label="Исходящие" name="OUTBOUND">
        <el-card v-if="pending.length" style="margin-bottom: 12px;">
          <template #header>
            <div class="card-head">
              <span>Реализации и возвраты без ЭСФ</span>
              <el-button v-if="canSend" size="small" type="primary" plain :loading="busy.prepareAll" @click="prepareAll">Сформировать все</el-button>
            </div>
          </template>
          <el-table :data="pending" size="small">
            <el-table-column label="Дата" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
            <el-table-column label="Документ" width="160"><template #default="{ row }"><el-link type="primary" @click="router.push(`/accounting/trade/${row.id}`)">{{ row.docType === 'SALES_RETURN' ? 'Возврат' : 'Реализация' }} {{ row.number }}</el-link></template></el-table-column>
            <el-table-column label="Покупатель" min-width="200"><template #default="{ row }">{{ row.counterparty }} <span class="muted">{{ row.counterpartyTin }}</span></template></el-table-column>
            <el-table-column label="Сумма" width="130" align="right"><template #default="{ row }">{{ fmtMoney(row.total) }}</template></el-table-column>
            <el-table-column width="140"><template #default="{ row }"><el-button v-if="canSend" size="small" :loading="row._busy" @click="prepare(row)">Сформировать</el-button></template></el-table-column>
          </el-table>
        </el-card>

        <el-card>
          <template #header>
            <div class="card-head">
              <span>Исходящие ЭСФ</span>
              <el-button v-if="canSend" type="success" :disabled="!selected.length" :loading="busy.send" @click="send">Подписать и отправить ({{ selected.length }})</el-button>
            </div>
          </template>
          <el-table :data="items" size="small" v-loading="loading" @selection-change="(r: any[]) => (selected = r)" empty-text="ЭСФ нет">
            <el-table-column type="selection" width="40" :selectable="(r: any) => r.status === 'READY'" />
            <el-table-column type="expand" width="30">
              <template #default="{ row }">
                <div v-if="row.errors?.length" class="errors">
                  <div v-for="(e, i) in row.errors" :key="i">• {{ e.text || e.errorCode }} <span class="muted" v-if="e.property">({{ e.property }})</span></div>
                </div>
                <div v-if="row.outdated" class="warn">Документ изменён или отменён после отправки ЭСФ — отзовите ЭСФ (кнопка «Отозвать») или выпишите исправленный ЭСФ в ИС ЭСФ.</div>
                <div v-if="row.cancelReason" class="muted" style="padding: 4px 12px;">Причина: {{ row.cancelReason }}</div>
                <div class="muted" v-if="!row.errors?.length && !row.outdated && !row.cancelReason">Замечаний нет</div>
              </template>
            </el-table-column>
            <el-table-column label="№" width="160"><template #default="{ row }">{{ row.num }} <el-tag v-if="row.invoiceType !== 'ORDINARY_INVOICE'" size="small" effect="plain">{{ TYPE[row.invoiceType] }}</el-tag></template></el-table-column>
            <el-table-column label="Выписан" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
            <el-table-column label="Оборот" width="100"><template #default="{ row }">{{ fmtDate(row.turnoverDate) }}</template></el-table-column>
            <el-table-column label="Получатель" min-width="200"><template #default="{ row }">{{ row.customerName }} <span class="muted">{{ row.customerTin }}</span></template></el-table-column>
            <el-table-column label="Без НДС" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.totalWithoutTax) }}</template></el-table-column>
            <el-table-column label="НДС" width="110" align="right"><template #default="{ row }">{{ fmtMoney(row.totalNds) }}</template></el-table-column>
            <el-table-column label="Всего" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.totalWithTax) }}</template></el-table-column>
            <el-table-column label="Статус" width="170">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType(row)">{{ statusLabel(row) }}</el-tag>
                <el-tag v-if="row.outdated" size="small" type="warning" style="margin-left: 4px;">исправить</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="Рег. номер" min-width="190"><template #default="{ row }"><span class="mono">{{ row.registrationNumber }}</span></template></el-table-column>
            <el-table-column width="170">
              <template #default="{ row }">
                <el-button size="small" link @click="showXml(row)">XML</el-button>
                <el-button v-if="canSend && ['READY', 'REJECTED'].includes(row.status)" size="small" link type="danger" @click="discard(row)">Отменить</el-button>
                <el-button v-if="canSend && canRevoke(row)" size="small" link type="danger" @click="act('REVOKE', row)">Отозвать</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="Входящие" name="INBOUND">
        <el-card>
          <el-table :data="items" size="small" v-loading="loading" empty-text="Входящих ЭСФ нет. Войдите в ИС ЭСФ и нажмите «Обновить» — FlowPOS загрузит новые ЭСФ поставщиков.">
            <el-table-column label="№" width="150"><template #default="{ row }">{{ row.num }} <el-tag v-if="row.invoiceType !== 'ORDINARY_INVOICE'" size="small" effect="plain">{{ TYPE[row.invoiceType] }}</el-tag></template></el-table-column>
            <el-table-column label="Выписан" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
            <el-table-column label="Поставщик" min-width="220"><template #default="{ row }">{{ row.sellerName }} <span class="muted">{{ row.sellerTin }}</span></template></el-table-column>
            <el-table-column label="Рег. номер" min-width="200"><template #default="{ row }"><span class="mono">{{ row.registrationNumber }}</span></template></el-table-column>
            <el-table-column label="Без НДС" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.totalWithoutTax) }}</template></el-table-column>
            <el-table-column label="НДС" width="110" align="right"><template #default="{ row }">{{ fmtMoney(row.totalNds) }}</template></el-table-column>
            <el-table-column label="Всего" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.totalWithTax) }}</template></el-table-column>
            <el-table-column label="Статус" width="150"><template #default="{ row }"><el-tag size="small" :type="statusType(row)">{{ statusLabel(row) }}</el-tag></template></el-table-column>
            <el-table-column width="230">
              <template #default="{ row }">
                <el-button size="small" link @click="showXml(row)">XML</el-button>
                <template v-if="canSend && waiting(row) === 'CONFIRM'">
                  <el-button size="small" link type="success" @click="act('APPROVE', row)">Подтвердить</el-button>
                  <el-button size="small" link type="danger" @click="act('DECLINE', row)">Отклонить</el-button>
                </template>
                <el-button v-if="canSend && waiting(row) === 'REVOKE'" size="small" link type="warning" @click="act('CONFIRM_REVOKE', row)">Подтвердить отзыв</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="Настройки" name="SETTINGS">
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

    <el-dialog v-model="xml.open" title="ЭСФ (XML)" width="760px">
      <pre class="xml">{{ xml.body }}</pre>
    </el-dialog>
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

const router = useRouter()
const org = useOrgStore()
const { t } = useI18n()
const canSend = computed(() => org.can('acc.esf.send'))
const tab = ref('OUTBOUND')
const loading = ref(false)
const busy = reactive({ login: false, refresh: false, send: false, save: false, prepareAll: false })
const settings = ref<any>(null)
const summary = ref<any>(null)
const items = ref<any[]>([])
const pending = ref<any[]>([])
const selected = ref<any[]>([])
const form = ref<any>(null)
const xml = reactive({ open: false, body: '' })

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
const STATUS: Record<string, [string, string]> = {
  READY: ['Готов к подписи', 'info'], SENT: ['Отправлен', ''], REJECTED: ['Отклонён (ФЛК)', 'danger'], CANCELLED: ['Отменён', 'info'],
  CREATED: ['Создан', ''], DELIVERED: ['Доставлен', 'success'], REVOKED: ['Отозван', 'warning'], DECLINED: ['Отклонён получателем', 'danger'],
  CANCELED: ['Аннулирован', 'warning'], IN_QUEUE: ['В очереди', ''], IN_PROCESSING: ['В обработке', ''], FAILED: ['Ошибочный', 'danger'],
  WAITING_CUSTOMER_CONFIRMATION: ['Ждёт подтверждения', 'warning'], WAITING_CUSTOMER_REVOKE_CONFIRMATION: ['Отзыв ждёт подтверждения', 'warning'],
}
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
    if (tab.value === 'SETTINGS') {
      const s = settings.value
      form.value = { environment: s.environment, signerIin: s.signerIin ?? '', operatorFullname: s.operatorFullname ?? '', signatureType: s.signatureType, vatRegistrationDate: s.vatRegistrationDate ? String(s.vatRegistrationDate).slice(0, 10) : null, transportTypeCode: s.transportTypeCode ?? '', defaultGoodsOrigin: s.defaultGoodsOrigin ?? '', autoPrepare: s.autoPrepare }
    } else {
      const r = (await api.get('/accounting/esf/invoices', { params: { direction: tab.value, limit: 200 } })) as any
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
  let ok = 0
  const failed: string[] = []
  for (const row of [...pending.value]) {
    try { await api.post(`/accounting/esf/prepare/${row.id}`); ok++ } catch (e: any) { failed.push(`${row.number}: ${e?.fix || e?.message}`) }
  }
  busy.prepareAll = false
  await load()
  if (failed.length) ElMessageBox.alert(`Сформировано: ${ok}\nНе сформировано: ${failed.length}\n\n${failed.join('\n\n')}`, 'Формирование ЭСФ', { confirmButtonText: 'OK' })
  else ElMessage.success(`Сформировано ЭСФ: ${ok}`)
}

async function send() {
  if (!settings.value?.session) return showError({ message: 'Нет входа в ИС ЭСФ', fix: 'Нажмите «Войти в ИС ЭСФ» и подпишите вход ключом ЭЦП.' })
  busy.send = true
  try {
    const sd = (await api.post('/accounting/esf/sign-data', { ids: selected.value.map((r) => r.id) })) as any
    const { certificate, signatures } = await signRaw(sd.items.map((i: any) => i.body))
    const r = (await api.post('/accounting/esf/upload', { certificate, items: sd.items.map((i: any, k: number) => ({ id: i.id, signature: signatures[k] })) })) as any
    if (r.declined) ElMessageBox.alert(`Принято ИС ЭСФ: ${r.accepted}\nОтклонено: ${r.declined} — раскройте строку, чтобы увидеть причину.`, 'Отправка ЭСФ', { confirmButtonText: 'OK', type: 'warning' })
    else ElMessage.success(`Отправлено ЭСФ: ${r.accepted}`)
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

/** Отзыв/отклонение/подтверждение: подпись списка id (и причины) ключом подписи в NCALayer. */
async function act(action: string, row: any) {
  if (!settings.value?.session) return showError({ message: 'Нет входа в ИС ЭСФ', fix: 'Нажмите «Войти в ИС ЭСФ» и подпишите вход ключом ЭЦП.' })
  const txt = ACT_TEXT[action]
  let reason: string | undefined
  try {
    if (txt.ask) reason = ((await ElMessageBox.prompt(`ЭСФ № ${row.num}. ${txt.ask}:`, txt.title, { confirmButtonText: 'Подписать и отправить', cancelButtonText: 'Отмена', inputValidator: (v: string) => !!v?.trim() || 'Укажите причину' })) as any).value
    else await ElMessageBox.confirm(`ЭСФ № ${row.num} от ${row.sellerName || row.customerName}. Подписать ЭЦП?`, txt.title, { confirmButtonText: 'Подписать', cancelButtonText: 'Отмена' })
  } catch { return }
  row._busy = true
  try {
    const d = (await api.post('/accounting/esf/actions/data', { action, ids: [row.id], reason })) as any
    const { certificate, signatures } = await signRaw([d.data])
    const r = (await api.post('/accounting/esf/actions', { action, ids: [row.id], reason, signature: signatures[0], certificate })) as any
    if (r.changed) ElMessage.success(txt.ok)
    else showError({ message: `ИС ЭСФ не выполнила операцию: ${r.items?.[0]?.error ?? ''}` })
    await load()
  } catch (e) { ncaError(e) }
  row._busy = false
}

async function discard(row: any) {
  try { await ElMessageBox.confirm(`Отменить ЭСФ № ${row.num}? Он не был зарегистрирован в ИС ЭСФ.`, 'Отмена ЭСФ', { type: 'warning', confirmButtonText: 'Отменить ЭСФ', cancelButtonText: 'Нет' }) } catch { return }
  try { await api.post(`/accounting/esf/invoices/${row.id}/discard`); await load() } catch (e) { showError(e) }
}

async function showXml(row: any) {
  try {
    const r = (await api.get(`/accounting/esf/invoices/${row.id}`)) as any
    xml.body = String(r.body).replace(/></g, '>\n<')
    xml.open = true
  } catch (e) { showError(e) }
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
.xml { max-height: 60vh; overflow: auto; background: #f5f7fa; padding: 12px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
</style>
