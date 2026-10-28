<template>
  <div>
    <div class="page-header"><h1>{{ t('bankImport') }}</h1></div>
    <el-card style="margin-bottom: 12px;">
      <el-form label-width="190px">
        <el-form-item :label="t('bankAccount')" required>
          <el-select v-model="bankAccountId" filterable style="width: 420px;">
            <el-option v-for="b in banks" :key="b.id" :value="b.id" :label="`${b.name} · ${b.iban} · ${b.currency}`" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('file')" required>
          <input type="file" accept=".csv,.txt,text/csv,text/plain" @change="onFile" />
          <span v-if="fileName" class="hint">{{ fileName }} · {{ encoding }}</span>
        </el-form-item>
        <el-form-item :label="t('mapping')">
          <el-collapse style="width: 100%; max-width: 760px;">
            <el-collapse-item title="Если названия колонок в выписке отличаются — укажите их (необязательно)">
              <div class="map-grid">
                <template v-for="m in MAP_FIELDS" :key="m.key">
                  <span>{{ m.label }}</span>
                  <el-select v-model="mapping[m.key]" clearable filterable allow-create size="small" :placeholder="m.def">
                    <el-option v-for="h in headers" :key="h" :value="h" :label="h" />
                  </el-select>
                </template>
              </div>
              <div class="hint">По умолчанию: Дата · Номер документа · Контрагент · БИН/ИИН · Дебет (списание) · Кредит (поступление) · Назначение платежа · КНП. Либо одна колонка «Сумма» со знаком.</div>
            </el-collapse-item>
          </el-collapse>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :disabled="!bankAccountId || !csv" :loading="busy" @click="doPreview">{{ t('preview') }}</el-button>
          <el-checkbox v-model="autoPost" style="margin-left: 16px;" :disabled="!org.can('acc.doc.post')">Сразу проводить строки с найденным контрагентом</el-checkbox>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-if="pv">
      <template #header>
        <div class="card-head">
          <span>
            Строк: <b>{{ pv.summary.total }}</b> · новых: <b>{{ pv.summary.new }}</b> · дублей: <b>{{ pv.summary.duplicates }}</b> · ошибок: <b>{{ pv.summary.errors }}</b>
            · поступления: <b>{{ fmtMoney(pv.summary.in) }}</b> · списания: <b>{{ fmtMoney(pv.summary.out) }}</b>
          </span>
          <el-button type="success" :disabled="!pv.summary.new" :loading="busy" @click="doImport">{{ t('load') }} ({{ pv.summary.new }})</el-button>
        </div>
      </template>
      <el-table :data="pv.rows" size="small" max-height="520" :row-class-name="({ row }: any) => row.action === 'ERROR' ? 'row-err' : row.duplicate ? 'row-dup' : ''">
        <el-table-column label="Стр." prop="row" width="60" />
        <el-table-column :label="t('date')" width="100"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
        <el-table-column label="Напр." width="80"><template #default="{ row }">{{ row.direction === 'IN' ? '↓ приход' : row.direction === 'OUT' ? '↑ расход' : '' }}</template></el-table-column>
        <el-table-column :label="t('amount')" width="130" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
        <el-table-column :label="t('counterparty')" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.counterpartyName }} <span class="hint">{{ row.counterpartyBin }}</span>
            <el-tag v-if="row.counterpartyMatched" size="small" type="success" style="margin-left: 4px;">найден</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('purpose')" prop="purpose" min-width="200" show-overflow-tooltip />
        <el-table-column label="Действие" width="220">
          <template #default="{ row }">
            <el-tag size="small" :type="ACTIONS[row.action]?.type as any">{{ ACTIONS[row.action]?.label || row.action }}</el-tag>
            <div v-if="row.errors?.length" class="err">{{ row.errors.join('; ') }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="result" style="margin-top: 12px;">
      <el-result :icon="result.errors?.length ? 'warning' : 'success'" :title="`Создано документов: ${result.created}`"
        :sub-title="`Проведено: ${result.posted} · черновиков: ${result.drafts} · пропущено: ${result.skipped}`">
        <template #extra>
          <div v-for="e in result.errors || []" :key="e.row" class="err">Строка {{ e.row }}: {{ e.message }}</div>
          <el-button type="primary" style="margin-top: 8px;" @click="router.push({ path: '/accounting/documents', query: {} })">К документам</el-button>
        </template>
      </el-result>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { fmtDate, fmtMoney, idem, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const { t } = useI18n()

const MAP_FIELDS = [
  { key: 'date', label: 'Дата', def: 'Дата' }, { key: 'docNumber', label: 'Номер документа', def: 'Номер документа' },
  { key: 'counterpartyName', label: 'Контрагент', def: 'Контрагент' }, { key: 'counterpartyBin', label: 'БИН/ИИН', def: 'БИН/ИИН' },
  { key: 'debit', label: 'Списание (дебет)', def: 'Дебет' }, { key: 'credit', label: 'Поступление (кредит)', def: 'Кредит' },
  { key: 'amount', label: 'Сумма со знаком', def: '—' }, { key: 'purpose', label: 'Назначение', def: 'Назначение платежа' }, { key: 'knp', label: 'КНП', def: 'КНП' },
]
const ACTIONS: Record<string, { label: string; type: string }> = {
  CUSTOMER_PAYMENT: { label: 'Оплата покупателя', type: 'success' },
  SUPPLIER_PAYMENT: { label: 'Оплата поставщику', type: 'success' },
  DRAFT_OTHER: { label: 'Черновик (прочее)', type: 'warning' },
  SKIP_DUPLICATE: { label: 'Уже загружено', type: 'info' },
  ERROR: { label: 'Ошибка', type: 'danger' },
}

const banks = ref<any[]>([])
const bankAccountId = ref<string>()
const csv = ref('')
const fileName = ref('')
const encoding = ref('')
const headers = ref<string[]>([])
const mapping = ref<Record<string, string | undefined>>({})
const autoPost = ref(true)
const busy = ref(false)
const pv = ref<any>(null)
const result = ref<any>(null)

function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  fileName.value = f.name
  const reader = new FileReader()
  reader.onload = () => {
    const buf = reader.result as ArrayBuffer
    let text = new TextDecoder('utf-8').decode(buf)
    encoding.value = 'UTF-8'
    if (text.includes('�')) {
      try { text = new TextDecoder('windows-1251').decode(buf); encoding.value = 'Windows-1251' } catch { /* оставляем UTF-8 */ }
    }
    csv.value = text.replace(/^﻿/, '')
    const first = csv.value.split(/\r?\n/, 1)[0] || ''
    const sep = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ';' : ','
    headers.value = first.split(sep).map((h) => h.replace(/^"|"$/g, '').trim()).filter(Boolean)
    pv.value = null
    result.value = null
  }
  reader.readAsArrayBuffer(f)
}

function cleanMapping() {
  const m = Object.fromEntries(Object.entries(mapping.value).filter(([, v]) => !!v))
  return Object.keys(m).length ? m : undefined
}

async function doPreview() {
  busy.value = true
  result.value = null
  try { pv.value = await api.post('/accounting/bank/statement/preview', { bankAccountId: bankAccountId.value, csv: csv.value, mapping: cleanMapping() }) } catch (e) { showError(e) }
  busy.value = false
}

async function doImport() {
  busy.value = true
  try {
    result.value = await api.post('/accounting/bank/statement/import', { bankAccountId: bankAccountId.value, csv: csv.value, mapping: cleanMapping(), autoPost: autoPost.value }, idem())
    ElMessage.success('Выписка загружена')
    await doPreview()
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(async () => {
  try {
    banks.value = ((await api.get('/accounting/refs/bank-accounts')) as any[]).filter((b) => b.isActive)
    if (banks.value.length === 1) bankAccountId.value = banks.value[0].id
  } catch (e) { showError(e) }
  if (!org.can('acc.doc.post')) autoPost.value = false
})
</script>

<style scoped>
.card-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.hint { color: #909399; font-size: 12px; margin-left: 8px; }
.err { color: #f56c6c; font-size: 12px; }
.map-grid { display: grid; grid-template-columns: 180px 1fr; gap: 6px 10px; align-items: center; margin-bottom: 8px; }
:deep(.row-err) { background: #fef0f0; }
:deep(.row-dup) { color: #a8abb2; }
</style>
