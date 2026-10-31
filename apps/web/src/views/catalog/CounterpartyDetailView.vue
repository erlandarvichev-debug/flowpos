<template>
  <!-- FP-026: карточка контрагента — реквизиты с датами действия и договоры текущей организации. -->
  <div v-loading="loading">
    <div class="page-header">
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <el-button :icon="ArrowLeft" circle aria-label="Назад" @click="$router.back()" />
        <h1>{{ cp?.name }}</h1>
        <el-tag v-if="cp" effect="plain">{{ KIND[cp.kind] ?? cp.kind }}</el-tag>
        <el-tag v-if="cp?.organizationId" type="info" effect="plain">личный для организации</el-tag>
        <el-tag v-if="cp?.deleted" type="danger">в архиве</el-tag>
      </div>
    </div>

    <el-row v-if="cp" :gutter="16">
      <el-col :xs="24" :md="14">
        <el-card>
          <template #header><b>Реквизиты</b></template>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="Полное наименование" :span="2">{{ cp.fullName || cp.name }}</el-descriptions-item>
            <el-descriptions-item :label="cp.kind === 'NONRESIDENT' ? 'Налоговый номер' : 'ИИН/БИН'">{{ cp.inn || '—' }}</el-descriptions-item>
            <el-descriptions-item label="Страна">{{ cp.countryCode }}</el-descriptions-item>
            <el-descriptions-item label="КБе">{{ cp.kbe || '—' }}</el-descriptions-item>
            <el-descriptions-item label="Роль">{{ TYPE[cp.type] ?? cp.type }}</el-descriptions-item>
            <el-descriptions-item label="Телефон">{{ cp.phone || '—' }}</el-descriptions-item>
            <el-descriptions-item label="Email">{{ cp.email || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div class="on">
            <span>Реквизиты на дату</span>
            <el-date-picker v-model="onDate" type="date" value-format="YYYY-MM-DD" :clearable="false" size="small" style="width: 150px;" @change="loadOn" />
          </div>
          <el-descriptions v-if="req" :column="1" border size="small">
            <el-descriptions-item label="Юридический адрес">{{ req.legalAddress?.line ?? 'не указан на эту дату' }}</el-descriptions-item>
            <el-descriptions-item label="Счёт">{{ req.bankAccount ? `${req.bankAccount.iban} · ${req.bankAccount.bankName} (${req.bankAccount.bik})` : 'нет действующего счёта' }}</el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header>
            <div class="hdr"><b>Договоры этой организации</b><el-button v-if="canManage" size="small" type="primary" @click="openContract()">Новый договор</el-button></div>
          </template>
          <el-table :data="cp.contracts" size="small" empty-text="Договоров с этим контрагентом у организации нет">
            <el-table-column label="Договор" min-width="160">
              <template #default="{ row }">№ {{ row.number }}<span v-if="row.date"> от {{ d(row.date) }}</span><div v-if="row.name" class="muted">{{ row.name }}</div></template>
            </el-table-column>
            <el-table-column label="Вид" width="110"><template #default="{ row }">{{ CTYPE[row.type] ?? '—' }}</template></el-table-column>
            <el-table-column label="Действует" width="190"><template #default="{ row }">{{ row.startDate ? d(row.startDate) : '…' }} — {{ row.endDate ? d(row.endDate) : 'бессрочно' }}</template></el-table-column>
            <el-table-column prop="currency" label="Валюта" width="80" />
            <el-table-column label="" width="120">
              <template #default="{ row }">
                <el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? 'действует' : 'закрыт' }}</el-tag>
                <div><el-button v-if="canManage" link type="primary" size="small" @click="openContract(row)">Изменить</el-button></div>
              </template>
            </el-table-column>
          </el-table>
          <div class="muted" style="margin-top: 8px;">Договоры других организаций клиента здесь не показываются и в документах этой организации недоступны.</div>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="10">
        <el-card>
          <template #header>
            <div class="hdr"><b>Адреса</b><el-button v-if="canManage" size="small" @click="addrOpen = true">Новый адрес</el-button></div>
          </template>
          <div v-for="a in cp.addresses" :key="a.id" class="row" :class="{ past: a.validTo }">
            <div><el-tag size="small" effect="plain">{{ AKIND[a.kind] }}</el-tag> {{ a.line }}</div>
            <div class="muted">с {{ d(a.validFrom) }}{{ a.validTo ? ` по ${d(a.validTo)}` : ' — действует' }}<span v-if="a.postalCode"> · индекс {{ a.postalCode }}</span></div>
          </div>
          <el-empty v-if="!cp.addresses.length" description="Адресов нет — в ЭСФ адрес покупателя не попадёт" :image-size="50" />
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header>
            <div class="hdr"><b>Банковские счета</b><el-button v-if="canManage" size="small" @click="bankOpen = true">Новый счёт</el-button></div>
          </template>
          <div v-for="b in cp.bankAccounts" :key="b.id" class="row" :class="{ past: b.validTo }">
            <div><code>{{ b.iban }}</code> <el-tag v-if="b.isDefault" size="small" type="success">основной</el-tag></div>
            <div class="muted">{{ b.bankName }} · {{ b.bik }} · {{ b.currency }} · с {{ d(b.validFrom) }}{{ b.validTo ? ` по ${d(b.validTo)}` : '' }}</div>
            <el-button v-if="canManage && !b.validTo" link type="danger" size="small" @click="closeBank(b)">Закрыть</el-button>
          </div>
          <el-empty v-if="!cp.bankAccounts.length" description="Счетов нет" :image-size="50" />
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="addrOpen" title="Новый адрес" width="520px">
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;" title="Прежний адрес того же вида закроется днём раньше — документы прошлых дат сохранят его." />
      <el-form label-width="120px">
        <el-form-item label="Вид"><el-select v-model="addr.kind"><el-option v-for="(l, k) in AKIND" :key="k" :label="l" :value="k" /></el-select></el-form-item>
        <el-form-item label="Адрес" required><el-input v-model="addr.line" type="textarea" :rows="2" placeholder="г. Алматы, пр. Абая, 10, офис 5" /></el-form-item>
        <el-form-item label="Индекс"><el-input v-model="addr.postalCode" style="width: 140px;" /></el-form-item>
        <el-form-item label="Действует с"><el-date-picker v-model="addr.validFrom" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="addrOpen = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="saveAddr">Сохранить</el-button></template>
    </el-dialog>

    <el-dialog v-model="bankOpen" title="Новый банковский счёт" width="520px">
      <el-form label-width="120px">
        <el-form-item label="IBAN" required><el-input v-model="bank.iban" placeholder="KZ…" /></el-form-item>
        <el-form-item label="БИК" required><el-input v-model="bank.bik" placeholder="HSBKKZKX" style="width: 180px;" /></el-form-item>
        <el-form-item label="Банк" required><el-input v-model="bank.bankName" /></el-form-item>
        <el-form-item label="Валюта"><el-input v-model="bank.currency" maxlength="3" style="width: 100px;" /></el-form-item>
        <el-form-item label="Действует с"><el-date-picker v-model="bank.validFrom" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item><el-checkbox v-model="bank.isDefault">Основной для валюты</el-checkbox></el-form-item>
      </el-form>
      <template #footer><el-button @click="bankOpen = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="saveBank">Сохранить</el-button></template>
    </el-dialog>

    <el-dialog v-model="kOpen" :title="k.id ? `Договор № ${k.number}` : 'Новый договор'" width="560px">
      <el-form label-width="150px">
        <el-form-item label="Номер" required><el-input v-model="k.number" /></el-form-item>
        <el-form-item label="Дата договора" required><el-date-picker v-model="k.date" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Предмет"><el-input v-model="k.name" placeholder="Поставка товаров" /></el-form-item>
        <el-form-item label="Вид"><el-select v-model="k.type" clearable><el-option v-for="(l, t) in CTYPE" :key="t" :label="l" :value="t" /></el-select></el-form-item>
        <el-form-item label="Действует с"><el-date-picker v-model="k.startDate" type="date" value-format="YYYY-MM-DD" placeholder="с даты договора" /></el-form-item>
        <el-form-item label="Действует по"><el-date-picker v-model="k.endDate" type="date" value-format="YYYY-MM-DD" placeholder="бессрочно" /></el-form-item>
        <el-form-item label="Валюта"><el-input v-model="k.currency" maxlength="3" style="width: 100px;" /></el-form-item>
        <el-form-item v-if="k.id"><el-checkbox v-model="k.isActive">Действует (закрытый договор нельзя выбрать в новых документах)</el-checkbox></el-form-item>
      </el-form>
      <template #footer><el-button @click="kOpen = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="saveContract">Сохранить</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'

const route = useRoute()
const org = useOrgStore()
const canManage = computed(() => org.can('catalog.manage'))
const id = route.params.id as string
const loading = ref(true)
const busy = ref(false)
const cp = ref<any>(null)
const req = ref<any>(null)
const today = new Date().toISOString().slice(0, 10)
const onDate = ref(today)

const KIND: Record<string, string> = { LEGAL: 'Юрлицо', ENTREPRENEUR: 'ИП', INDIVIDUAL: 'Физлицо', NONRESIDENT: 'Нерезидент' }
const TYPE: Record<string, string> = { CUSTOMER: 'Покупатель', SUPPLIER: 'Поставщик', BOTH: 'Покупатель и поставщик' }
const AKIND: Record<string, string> = { LEGAL: 'Юридический', ACTUAL: 'Фактический', DELIVERY: 'Доставки' }
const CTYPE: Record<string, string> = { SALE: 'Продажа', PURCHASE: 'Закупка', COMMISSION: 'Комиссия', OTHER: 'Прочее' }
const d = (v: string) => new Date(v).toLocaleDateString('ru-RU', { timeZone: 'UTC' })

const addrOpen = ref(false)
const addr = reactive({ kind: 'LEGAL', line: '', postalCode: '', validFrom: today })
const bankOpen = ref(false)
const bank = reactive({ iban: '', bik: '', bankName: '', currency: 'KZT', isDefault: false, validFrom: today })
const kOpen = ref(false)
const k = ref<any>({})

async function load() {
  loading.value = true
  try {
    cp.value = await api.get(`/catalog/counterparties/${id}`)
    await loadOn()
  } catch (e) { showError(e) }
  loading.value = false
}
async function loadOn() {
  try { req.value = await api.get(`/catalog/counterparties/${id}/requisites`, { params: { on: onDate.value } }) } catch (e) { showError(e) }
}

async function run(fn: () => Promise<unknown>, ok: string, close: () => void) {
  busy.value = true
  try {
    await fn()
    ElMessage.success(ok)
    close()
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}
const saveAddr = () => run(() => api.post(`/catalog/counterparties/${id}/addresses`, addr), 'Адрес сохранён', () => { addrOpen.value = false; addr.line = ''; addr.postalCode = '' })
const saveBank = () => run(() => api.post(`/catalog/counterparties/${id}/bank-accounts`, bank), 'Счёт добавлен', () => { bankOpen.value = false; bank.iban = ''; bank.bik = ''; bank.bankName = '' })

async function closeBank(b: any) {
  let validTo: string
  try {
    const r = await ElMessageBox.prompt(`Закрыть счёт ${b.iban}? Документы прошлых дат сохранят его.`, 'Закрыть счёт', { inputValue: today, inputPattern: /^\d{4}-\d{2}-\d{2}$/, inputErrorMessage: 'Дата — ГГГГ-ММ-ДД', confirmButtonText: 'Закрыть', cancelButtonText: 'Отмена' })
    validTo = r.value
  } catch { return }
  await run(() => api.post(`/catalog/counterparties/${id}/bank-accounts/${b.id}/close`, { validTo }), 'Счёт закрыт', () => {})
}

const iso = (v?: string | null) => (v ? String(v).slice(0, 10) : null)
function openContract(row?: any) {
  k.value = row
    ? { id: row.id, number: row.number, date: iso(row.date), name: row.name, type: row.type, startDate: iso(row.startDate), endDate: iso(row.endDate), currency: row.currency, isActive: row.isActive }
    : { number: '', date: today, name: '', type: 'SALE', startDate: null, endDate: null, currency: 'KZT' }
  kOpen.value = true
}
function saveContract() {
  const { id: kid, ...body } = k.value
  return run(() => (kid ? api.put(`/catalog/counterparties/${id}/contracts/${kid}`, body) : api.post(`/catalog/counterparties/${id}/contracts`, body)), 'Договор сохранён', () => { kOpen.value = false })
}

onMounted(load)
</script>

<style scoped>
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.hdr { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.row { margin-bottom: 12px; }
.row.past { opacity: 0.6; }
.on { display: flex; align-items: center; gap: 8px; margin: 14px 0 8px; font-weight: 600; flex-wrap: wrap; }
</style>
