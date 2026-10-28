<template>
  <div>
    <div class="page-header"><h1>{{ t('refs') }}</h1></div>
    <el-card>
      <el-tabs v-model="tab" @tab-change="load">
        <el-tab-pane v-for="r in REFS" :key="r.kind" :label="r.title" :name="r.kind" />
        <el-tab-pane label="Валюты и курсы" name="rates" />
        <el-tab-pane label="Ставки НДС" name="vat" />
      </el-tabs>

      <!-- Справочники организации -->
      <template v-if="current">
        <div style="margin-bottom: 12px;" v-if="org.can('acc.refs.manage')">
          <el-button type="primary" :icon="Plus" @click="openForm()">{{ t('create') }}</el-button>
        </div>
        <el-table :data="rows" size="small" v-loading="loading" @row-dblclick="openForm">
          <el-table-column v-for="c in current.columns" :key="c.key" :label="c.label" :prop="c.key" :min-width="c.width || 140">
            <template #default="{ row }">
              <template v-if="c.key === 'isActive'"><el-tag size="small" :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? 'да' : 'нет' }}</el-tag></template>
              <template v-else-if="c.key === 'kind'">{{ KIND_LABELS[row.kind] || row.kind }}</template>
              <template v-else>{{ row[c.key] }}</template>
            </template>
          </el-table-column>
          <el-table-column width="90" v-if="org.can('acc.refs.manage')">
            <template #default="{ row }"><el-button link type="primary" size="small" @click="openForm(row)">Изменить</el-button></template>
          </el-table-column>
        </el-table>
      </template>

      <!-- Курсы -->
      <template v-else-if="tab === 'rates'">
        <el-row :gutter="20">
          <el-col :md="8" :span="24">
            <h4>Валюты</h4>
            <el-table :data="currencies" size="small">
              <el-table-column label="Код" prop="code" width="70" />
              <el-table-column label="№" prop="numericCode" width="60" />
              <el-table-column label="Наименование" min-width="140"><template #default="{ row }">{{ nm(row) }}</template></el-table-column>
            </el-table>
          </el-col>
          <el-col :md="16" :span="24">
            <h4>Курсы</h4>
            <div class="filters" v-if="org.can('acc.refs.manage')">
              <el-select v-model="rate.currency" placeholder="Валюта" style="width: 100px;">
                <el-option v-for="c in currencies.filter((x) => x.code !== 'KZT')" :key="c.code" :value="c.code" :label="c.code" />
              </el-select>
              <el-date-picker v-model="rate.date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" style="width: 150px;" />
              <el-input v-model="rate.rate" placeholder="Курс, ₸" style="width: 130px;" />
              <el-input-number v-model="rate.multiplier" :min="1" controls-position="right" style="width: 110px;" />
              <el-button type="primary" @click="saveRate">Записать курс</el-button>
            </div>
            <el-table :data="rates" size="small" v-loading="loading">
              <el-table-column label="Дата" width="110"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
              <el-table-column label="Валюта" prop="currencyCode" width="80" />
              <el-table-column label="Курс, ₸" prop="rate" width="140" align="right" />
              <el-table-column label="Кратность" prop="multiplier" width="100" align="right" />
              <el-table-column label="Источник" prop="source" />
            </el-table>
          </el-col>
        </el-row>
      </template>

      <!-- НДС -->
      <template v-else-if="tab === 'vat'">
        <el-table :data="vat" size="small" v-loading="loading">
          <el-table-column label="Код" prop="code" width="120" />
          <el-table-column label="Ставка, %" prop="rate" width="100" align="right" />
          <el-table-column label="Действует с" width="120"><template #default="{ row }">{{ fmtDate(row.validFrom) }}</template></el-table-column>
          <el-table-column label="по" width="120"><template #default="{ row }">{{ fmtDate(row.validTo) || '—' }}</template></el-table-column>
          <el-table-column label="Проверено" width="160">
            <template #default="{ row }"><el-tag size="small" :type="row.verified ? 'success' : 'warning'">{{ row.verified ? 'подтверждено' : 'требует проверки' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="Источник" prop="source" min-width="200" />
        </el-table>
      </template>
    </el-card>

    <el-dialog v-model="formVisible" :title="form.id ? 'Изменить' : 'Создать'" width="520px">
      <el-form v-if="current" :model="form" label-width="140px">
        <el-form-item v-for="f in current.fields" :key="f.key" :label="f.label">
          <el-select v-if="f.key === 'kind'" v-model="form.kind" style="width: 100%;">
            <el-option v-for="(l, k) in KIND_LABELS" :key="k" :value="k" :label="l" />
          </el-select>
          <el-select v-else-if="f.key === 'currency'" v-model="form.currency" style="width: 100%;">
            <el-option v-for="c in currencies" :key="c.code" :value="c.code" :label="c.code" />
          </el-select>
          <el-select v-else-if="f.key === 'storeId'" v-model="form.storeId" clearable style="width: 100%;">
            <el-option v-for="s in stores" :key="s.id" :value="s.id" :label="s.name" />
          </el-select>
          <el-switch v-else-if="f.key === 'isActive'" v-model="form.isActive" />
          <el-input v-else v-model="form[f.key]" :placeholder="f.placeholder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">{{ t('close') }}</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{ t('save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { fmtDate, idem, normAmount, showError } from './acc'

const route = useRoute()
const org = useOrgStore()
const { t, nm } = useI18n()

const KIND_LABELS: Record<string, string> = { INCOME: 'Доходы', EXPENSE: 'Расходы', CASHFLOW: 'Движение денег' }

interface RefDef { kind: string; title: string; columns: { key: string; label: string; width?: number }[]; fields: { key: string; label: string; placeholder?: string }[]; defaults: any }
const REFS: RefDef[] = [
  {
    kind: 'bank-accounts', title: 'Банковские счета',
    columns: [{ key: 'name', label: 'Название' }, { key: 'iban', label: 'IBAN', width: 220 }, { key: 'bic', label: 'БИК' }, { key: 'bankName', label: 'Банк' }, { key: 'currency', label: 'Валюта', width: 80 }, { key: 'accountCode', label: 'Счёт учёта', width: 100 }, { key: 'isActive', label: 'Активен', width: 90 }],
    fields: [{ key: 'name', label: 'Название' }, { key: 'iban', label: 'IBAN', placeholder: 'KZ…' }, { key: 'bic', label: 'БИК', placeholder: 'HSBKKZKX' }, { key: 'bankName', label: 'Банк' }, { key: 'currency', label: 'Валюта' }, { key: 'accountCode', label: 'Счёт учёта' }, { key: 'isActive', label: 'Активен' }],
    defaults: { currency: 'KZT', accountCode: '1030', isActive: true },
  },
  {
    kind: 'cashboxes', title: 'Кассы',
    columns: [{ key: 'name', label: 'Название' }, { key: 'currency', label: 'Валюта', width: 80 }, { key: 'accountCode', label: 'Счёт учёта', width: 100 }, { key: 'isActive', label: 'Активна', width: 90 }],
    fields: [{ key: 'name', label: 'Название' }, { key: 'currency', label: 'Валюта' }, { key: 'storeId', label: 'Склад/магазин' }, { key: 'accountCode', label: 'Счёт учёта' }, { key: 'isActive', label: 'Активна' }],
    defaults: { currency: 'KZT', accountCode: '1010', isActive: true },
  },
  {
    kind: 'items', title: 'Статьи',
    columns: [{ key: 'kind', label: 'Вид', width: 140 }, { key: 'code', label: 'Код', width: 100 }, { key: 'name', label: 'Наименование' }, { key: 'nameKk', label: 'Атауы' }, { key: 'isActive', label: 'Активна', width: 90 }],
    fields: [{ key: 'kind', label: 'Вид' }, { key: 'code', label: 'Код' }, { key: 'name', label: 'Наименование' }, { key: 'nameKk', label: 'Атауы (қаз.)' }, { key: 'isActive', label: 'Активна' }],
    defaults: { kind: 'EXPENSE', isActive: true },
  },
  {
    kind: 'projects', title: 'Проекты',
    columns: [{ key: 'code', label: 'Код', width: 120 }, { key: 'name', label: 'Наименование' }, { key: 'isActive', label: 'Активен', width: 90 }],
    fields: [{ key: 'code', label: 'Код' }, { key: 'name', label: 'Наименование' }, { key: 'isActive', label: 'Активен' }],
    defaults: { isActive: true },
  },
]

const tab = ref<string>((route.query.tab as string) || 'bank-accounts')
const current = computed(() => REFS.find((r) => r.kind === tab.value))
const loading = ref(false)
const saving = ref(false)
const rows = ref<any[]>([])
const currencies = ref<any[]>([])
const rates = ref<any[]>([])
const vat = ref<any[]>([])
const stores = ref<any[]>([])
const formVisible = ref(false)
const form = ref<any>({})
const rate = ref<any>({ currency: 'USD', date: dayjs().format('YYYY-MM-DD'), rate: '', multiplier: 1 })

async function load() {
  loading.value = true
  try {
    if (current.value) rows.value = (await api.get(`/accounting/refs/${current.value.kind}`)) as any
    else if (tab.value === 'rates') rates.value = (await api.get('/accounting/refs/rates')) as any
    else if (tab.value === 'vat') vat.value = (await api.get('/accounting/refs/vat-rates')) as any
  } catch (e) { showError(e) }
  loading.value = false
}

function openForm(row?: any) {
  if (!current.value || !org.can('acc.refs.manage')) return
  form.value = row ? { ...row } : { ...current.value.defaults }
  formVisible.value = true
}

async function save() {
  if (!current.value) return
  saving.value = true
  const allowed = current.value.fields.map((f) => f.key)
  const data = Object.fromEntries(Object.entries(form.value).filter(([k]) => allowed.includes(k)))
  try {
    if (form.value.id) await api.put(`/accounting/refs/${current.value.kind}/${form.value.id}`, data, idem())
    else await api.post(`/accounting/refs/${current.value.kind}`, data, idem())
    ElMessage.success('Сохранено')
    formVisible.value = false
    await load()
  } catch (e) { showError(e) }
  saving.value = false
}

async function saveRate() {
  try {
    await api.post('/accounting/refs/rates', { ...rate.value, rate: normAmount(rate.value.rate) }, idem())
    ElMessage.success('Курс записан')
    rate.value.rate = ''
    await load()
  } catch (e) { showError(e) }
}

onMounted(async () => {
  try {
    currencies.value = (await api.get('/accounting/refs/currencies')) as any
    stores.value = (await api.get('/catalog/warehouses')) as any
  } catch { /* необязательно */ }
  load()
})
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
</style>
