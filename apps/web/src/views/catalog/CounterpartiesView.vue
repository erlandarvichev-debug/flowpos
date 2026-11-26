<template>
  <div>
    <PageHeader title="Контрагенты" subtitle="Покупатели и поставщики: реквизиты, договоры, долги">
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить</el-button>
    </PageHeader>

    <el-card shadow="never">
      <DataTable
        :columns="columns" :rows="list" :loading="loading" :error="error" :total="total" v-model:page="page" v-model:limit="limit"
        storage-key="counterparties" clickable export-name="контрагенты" :fetch-all="fetchAll" :unit="['контрагент', 'контрагента', 'контрагентов']"
        :empty-text="search || typeFilter ? 'Ничего не найдено' : 'Контрагентов пока нет — добавьте первого'"
        @row-click="(r: any) => router.push(`/catalog/counterparties/${r.id}`)" @retry="loadList"
      >
        <template #filters>
          <el-input v-model="search" placeholder="Название, ИИН/БИН, телефон" :prefix-icon="Search" clearable class="w-search" @input="debouncedLoad" @clear="reload" />
          <el-radio-group v-model="typeFilter" @change="reload">
            <el-radio-button value="">Все</el-radio-button>
            <el-radio-button value="CUSTOMER">Покупатели</el-radio-button>
            <el-radio-button value="SUPPLIER">Поставщики</el-radio-button>
          </el-radio-group>
        </template>
        <template #cell-name="{ row }">
          <span class="name">{{ row.name }}</span>
          <el-tag v-if="row.kind && row.kind !== 'LEGAL'" size="small" effect="plain" class="ml">{{ kindLabels[row.kind] }}</el-tag>
          <el-tag v-if="row.organizationId" size="small" type="info" effect="plain" class="ml">личный</el-tag>
        </template>
        <template #cell-type="{ row }">
          <el-tag :type="row.type === 'CUSTOMER' ? 'success' : row.type === 'SUPPLIER' ? 'warning' : 'info'" size="small" effect="light">{{ typeLabels[row.type] }}</el-tag>
        </template>
        <template #cell-balance="{ row }">
          <template v-if="balances[row.id]">
            <span v-if="balances[row.id] > 0" class="owe-us" title="Должен нам">{{ fmtMoney(balances[row.id]) }}</span>
            <span v-else class="we-owe" title="Мы должны">−{{ fmtMoney(-balances[row.id]) }}</span>
          </template>
          <span v-else class="muted">—</span>
        </template>
        <template #actions="{ row }">
          <el-button size="small" text :icon="Edit" aria-label="Редактировать" @click="openForm(row)" />
        </template>
      </DataTable>
    </el-card>

    <el-dialog v-model="formVisible" :title="editItem ? 'Редактировать' : 'Новый контрагент'" width="560px">
      <el-form :model="form" label-width="130px">
        <el-form-item label="Наименование" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Полное"><el-input v-model="form.fullName" placeholder="ТОО «…» — как в документах" /></el-form-item>
        <el-form-item label="Вид">
          <el-select v-model="form.kind" @change="onKind">
            <el-option v-for="(l, k) in kindLabels" :key="k" :label="l" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="Роль">
          <el-select v-model="form.type">
            <el-option label="Покупатель" value="CUSTOMER" />
            <el-option label="Поставщик" value="SUPPLIER" />
            <el-option label="Покупатель и поставщик" value="BOTH" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.kind === 'NONRESIDENT'" label="Страна">
          <el-input v-model="form.countryCode" maxlength="2" placeholder="CN, RU, US…" style="width: 100px;" />
        </el-form-item>
        <el-form-item :label="form.kind === 'NONRESIDENT' ? 'Налоговый номер' : 'ИИН/БИН'"><el-input v-model="form.inn" :maxlength="form.kind === 'NONRESIDENT' ? 40 : 12" /></el-form-item>
        <el-form-item label="КБе"><el-input v-model="form.kbe" maxlength="2" placeholder="17" style="width: 100px;" /></el-form-item>
        <el-form-item label="Отсрочка оплаты">
          <el-input-number v-model="form.paymentDays" :min="0" :max="365" :controls="false" placeholder="—" style="width: 100px;" /> <span class="hint" style="margin-left: 8px;">дней (пусто — оплата в день отгрузки)</span>
        </el-form-item>
        <el-form-item label="Телефон"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="Email"><el-input v-model="form.email" /></el-form-item>
        <el-form-item v-if="!editItem"><el-checkbox v-model="form.own">Личный — только для этой организации</el-checkbox></el-form-item>
        <div v-if="!editItem" class="hint">Адрес, банковские счета и договоры — в карточке контрагента после сохранения.</div>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="save" :loading="saving">Сохранить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { Plus, Search, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'
import PageHeader from '@/components/ui/PageHeader.vue'
import DataTable, { type Col } from '@/components/ui/DataTable.vue'
import { fmtMoney } from '@/utils/format'

const loading = ref(false)
const saving = ref(false)
const list = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const limit = ref(50)
const error = ref('')
/** Сальдо расчётов: + должен нам, − мы должны (из взаиморасчётов; только при праве на отчёты). */
const balances = ref<Record<string, number>>({})
const columns = computed<Col[]>(() => [
  { key: 'name', label: 'Наименование', minWidth: 240, required: true, export: (r) => r.name },
  { key: 'type', label: 'Роль', width: 130, export: (r) => typeLabels[r.type] ?? r.type },
  { key: 'inn', label: 'ИИН/БИН', width: 140 },
  { key: 'balance', label: 'Сальдо, ₸', width: 140, align: 'right', hidden: !org.can('acc.reports.read'), export: (r) => (balances.value[r.id] ?? 0) },
  { key: 'phone', label: 'Телефон', width: 150 },
  { key: 'email', label: 'Email', minWidth: 180, ellipsis: true },
  { key: 'fullName', label: 'Полное наименование', minWidth: 220, hidden: true, ellipsis: true },
  { key: 'kbe', label: 'КБе', width: 70, hidden: true },
])
const search = ref('')
const typeFilter = ref('')
const formVisible = ref(false)
const editItem = ref<any>(null)
const form = ref<any>({})
const typeLabels: Record<string, string> = { CUSTOMER: 'Покупатель', SUPPLIER: 'Поставщик', BOTH: 'Оба' }
const kindLabels: Record<string, string> = { LEGAL: 'Юрлицо', ENTREPRENEUR: 'ИП', INDIVIDUAL: 'Физлицо', NONRESIDENT: 'Нерезидент' }
const router = useRouter()
const org = useOrgStore()
function onKind(k: string) {
  if (k !== 'NONRESIDENT') form.value.countryCode = 'KZ'
  else if (form.value.countryCode === 'KZ') form.value.countryCode = ''
}

let debounceTimer: ReturnType<typeof setTimeout>
function debouncedLoad() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(reload, 350)
}
function reload() { if (page.value !== 1) page.value = 1; else loadList() }
watch([page, limit], () => loadList())

const params = (extra: Record<string, unknown> = {}) => ({ search: search.value || undefined, type: typeFilter.value || undefined, page: page.value, limit: limit.value, ...extra })
let seq = 0
async function loadList() {
  const my = ++seq
  loading.value = true
  error.value = ''
  try {
    const res = (await api.get('/catalog/counterparties', { params: params() })) as any
    if (my !== seq) return
    list.value = res.items ?? []
    total.value = res.total ?? 0
  } catch (e: any) {
    if (my === seq) error.value = e?.message || 'Не удалось загрузить контрагентов'
  } finally {
    if (my === seq) loading.value = false
  }
}
async function fetchAll() {
  const all: any[] = []
  for (let p = 1; p <= 50; p++) {
    const res = (await api.get('/catalog/counterparties', { params: params({ page: p, limit: 200 }) })) as any
    all.push(...(res.items ?? []))
    if (all.length >= res.total || !res.items?.length) break
  }
  return all
}
async function loadBalances() {
  // права организации подгружаются позже страницы — запрос без проверки, отказ в доступе просто без сальдо
  try {
    const r = (await api.get('/accounting/reports/settlements')) as any
    const m: Record<string, number> = {}
    for (const l of r.lines ?? []) m[l.counterpartyId] = Number(l.receivable) - Number(l.advanceReceived) - Number(l.payable) + Number(l.advancePaid)
    balances.value = m
  } catch { /* без сальдо */ }
}

function openForm(item?: any) {
  editItem.value = item || null
  // FP-026: поля API (адреса — в карточке, с датами действия).
  form.value = item
    ? { name: item.name, fullName: item.fullName, kind: item.kind ?? 'LEGAL', type: item.type, inn: item.inn, kbe: item.kbe, countryCode: item.countryCode ?? 'KZ', phone: item.phone, email: item.email, paymentDays: item.paymentDays ?? null }
    : { name: '', fullName: '', kind: 'LEGAL', type: 'CUSTOMER', inn: '', kbe: '', countryCode: 'KZ', phone: '', email: '', paymentDays: null, own: false }
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    const { own, ...body } = form.value
    if (editItem.value) {
      await api.put(`/catalog/counterparties/${editItem.value.id}`, body)
      ElMessage.success('Обновлено')
      formVisible.value = false
      loadList()
    } else {
      const created: any = await api.post('/catalog/counterparties', { ...body, organizationId: own ? org.currentId : undefined })
      ElMessage.success('Создано — добавьте адрес и договор')
      formVisible.value = false
      router.push(`/catalog/counterparties/${created.id}`)
    }
  } catch (e) { showError(e) }
  saving.value = false
}

onMounted(() => { loadList(); loadBalances() })
</script>

<style scoped>
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-left: 130px; }
.w-search { width: 300px; }
.name { font-weight: 500; }
.ml { margin-left: 6px; }
.owe-us { color: var(--el-color-success-dark-2); font-weight: 500; font-variant-numeric: tabular-nums; }
.we-owe { color: var(--el-color-danger); font-weight: 500; font-variant-numeric: tabular-nums; }
.muted { color: var(--el-text-color-placeholder); }
@media (max-width: 640px) { .w-search { width: 100%; } }
</style>
