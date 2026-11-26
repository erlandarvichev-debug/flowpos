<template>
  <div>
    <PageHeader title="Долги по срокам" subtitle="Кто сколько должен, когда срок оплаты и сколько дней просрочки">
      <el-button :icon="Download" :disabled="!rows.length" @click="exportCsv">CSV</el-button>
    </PageHeader>

    <el-card shadow="never">
      <div class="filters">
        <el-radio-group v-model="side" @change="load">
          <el-radio-button value="customers">Нам должны покупатели</el-radio-button>
          <el-radio-button value="suppliers">Мы должны поставщикам</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 150px;" @change="load" />
        <el-input v-model="search" placeholder="Контрагент, БИН" clearable style="width: 220px;" :prefix-icon="Search" />
        <el-checkbox v-model="onlyOverdue">Только просроченные</el-checkbox>
      </div>

      <div class="kpis">
        <div class="kpi"><span class="kpi-ic" style="--c: #1769e0"><el-icon><component is="Wallet" /></el-icon></span><div class="k-label">Всего долг</div><div class="k-val">{{ fmtTenge(sum('total')) }}</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #23a047"><el-icon><component is="CircleCheck" /></el-icon></span><div class="k-label">В срок</div><div class="k-val ok">{{ fmtTenge(sum('notDue')) }}</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #dc2626"><el-icon><component is="Warning" /></el-icon></span><div class="k-label">Просрочено</div><div class="k-val bad">{{ fmtTenge(sum('overdue')) }}</div><div class="k-sub">{{ overdueShare }}</div></div>
        <div class="kpi"><span class="kpi-ic" style="--c: #b45309"><el-icon><component is="Timer" /></el-icon></span><div class="k-label">Больше 90 дней</div><div class="k-val bad">{{ fmtTenge(sum('d90plus')) }}</div></div>
      </div>

      <el-table :data="rows" size="small" v-loading="loading" row-key="counterpartyId" :empty-text="error || 'Долгов нет'" show-summary :summary-method="summary" class="aging">
        <el-table-column type="expand" width="36">
          <template #default="{ row }">
            <div class="docs">
              <div v-for="d in row.docs" :key="(d.id || 'none') + d.date" class="doc" :class="{ link: d.id }" @click="openDoc(d)">
                <span class="d-num">{{ d.number ? `${docLabel(d.docType)} ${d.number}` : 'Остаток без документа' }}</span>
                <span class="muted">от {{ fmtDate(d.date) }}</span>
                <span class="muted">срок {{ fmtDate(d.dueDate) }}<template v-if="d.termSource !== 'NONE'"> · {{ TERM[d.termSource] }}</template></span>
                <span class="d-sum" :class="{ neg: Number(d.amount) < 0 }">{{ fmtMoney(d.amount) }}</span>
                <el-tag v-if="d.overdueDays > 0" size="small" :type="d.overdueDays > 60 ? 'danger' : 'warning'" effect="light">просрочено {{ d.overdueDays }} {{ plural(d.overdueDays, 'день', 'дня', 'дней') }}</el-tag>
                <el-tag v-else-if="Number(d.amount) < 0" size="small" type="info" effect="plain">переплата</el-tag>
                <el-tag v-else size="small" type="success" effect="plain">в срок</el-tag>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="Контрагент" min-width="220">
          <template #default="{ row }">
            <div class="cp">{{ row.name || '—' }}</div>
            <div class="muted small">{{ row.bin }}<template v-if="row.paymentDays != null"> · отсрочка {{ row.paymentDays }} дн.</template></div>
          </template>
        </el-table-column>
        <el-table-column label="Всего" width="130" align="right"><template #default="{ row }"><b>{{ fmtMoney(row.total) }}</b></template></el-table-column>
        <el-table-column label="В срок" width="120" align="right"><template #default="{ row }">{{ money0(row.notDue) }}</template></el-table-column>
        <el-table-column v-for="b in BUCKETS" :key="b.key" :label="b.label" width="115" align="right">
          <template #default="{ row }"><span :class="Number(row[b.key]) ? b.cls : ''">{{ money0(row[b.key]) }}</span></template>
        </el-table-column>
        <el-table-column label="Макс. просрочка" width="120" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.maxOverdueDays" size="small" :type="row.maxOverdueDays > 60 ? 'danger' : 'warning'">{{ row.maxOverdueDays }} дн.</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column width="120" align="right">
          <template #default="{ row }">
            <el-tooltip content="Акт сверки" placement="top"><el-button link :icon="DocumentChecked" @click.stop="reconcile(row)" /></el-tooltip>
            <el-tooltip v-if="side === 'customers' && waPhone(row.phone)" content="Напомнить в WhatsApp" placement="top">
              <el-button link :icon="ChatDotRound" @click.stop="remind(row)" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">
        Срок оплаты: «Оплатить до» в документе, иначе дата документа + отсрочка договора, иначе + отсрочка контрагента, иначе — в день отгрузки.
        Отсрочку задают в карточке контрагента и в договоре. Строку можно раскрыть — документы с долгом; клик открывает документ.
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChatDotRound, DocumentChecked, Download, Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { fmtDate, fmtMoney, fmtTenge, kzToday, plural } from '@/utils/format'
import { downloadCsv } from '@/utils/csv'
import { useOrgStore } from '@/stores/org'

const route = useRoute()
const router = useRouter()
const org = useOrgStore()
const BUCKETS = [
  { key: 'd1_30', label: '1–30 дн.', cls: 'warn' }, { key: 'd31_60', label: '31–60 дн.', cls: 'warn' },
  { key: 'd61_90', label: '61–90 дн.', cls: 'bad' }, { key: 'd90plus', label: '> 90 дн.', cls: 'bad' },
]
const TERM: Record<string, string> = { DOC: 'указан в документе', CONTRACT: 'по договору', COUNTERPARTY: 'отсрочка контрагента' }
const DOC_LABELS: Record<string, string> = { DEMAND: 'Реализация', SUPPLY: 'Поступление', SALES_RETURN: 'Возврат покупателя', PURCHASE_RETURN: 'Возврат поставщику', RETAIL_DEMAND: 'Чек', OPENING_BALANCE: 'Ввод остатков', MANUAL_OPERATION: 'Операция' }
const docLabel = (t: string | null) => (t ? DOC_LABELS[t] ?? 'Документ' : 'Документ')

const side = ref<'customers' | 'suppliers'>(route.query.side === 'suppliers' ? 'suppliers' : 'customers')
const date = ref(kzToday())
const search = ref('')
const onlyOverdue = ref(false)
const loading = ref(false)
const error = ref('')
const data = ref<any>(null)

const rows = computed(() => {
  const q = search.value.trim().toLowerCase()
  return (data.value?.lines ?? []).filter((l: any) =>
    (!q || (l.name || '').toLowerCase().includes(q) || (l.bin || '').includes(q)) && (!onlyOverdue.value || Number(l.overdue) > 0))
})
const sum = (k: string) => rows.value.reduce((a: number, r: any) => a + Number(r[k] || 0), 0)
const overdueShare = computed(() => {
  const t = sum('total')
  return t > 0 ? `${Math.round((sum('overdue') / t) * 100)}% от долга` : ''
})
const money0 = (v: any) => (Number(v) ? fmtMoney(v) : '')

function summary({ columns }: any) {
  const keys = [null, null, 'total', 'notDue', ...BUCKETS.map((b) => b.key), null, null]
  return columns.map((_: any, i: number) => (i === 1 ? 'Итого' : keys[i] ? fmtMoney(sum(keys[i] as string)) : ''))
}

async function load() {
  loading.value = true
  error.value = ''
  try { data.value = await api.get('/accounting/reports/debt-aging', { params: { side: side.value, date: date.value } }) } catch (e: any) {
    data.value = null
    error.value = e?.message || 'Не удалось построить отчёт'
  } finally { loading.value = false }
}

function openDoc(d: any) {
  if (!d.id) return
  router.push(d.kind === 'TRADE' ? `/accounting/trade/${d.id}` : `/accounting/documents/${d.id}`)
}
function reconcile(row: any) {
  router.push({ path: '/reports/reconciliation', query: { counterpartyId: row.counterpartyId, name: row.name } })
}

/** Номер для WhatsApp: только цифры, казахстанский 8XXXXXXXXXX → 7XXXXXXXXXX. */
function waPhone(p?: string | null) {
  let d = String(p || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`
  if (d.length === 10) d = `7${d}`
  return d.length >= 11 ? d : ''
}
function remind(row: any) {
  const overdue = row.docs.filter((d: any) => d.overdueDays > 0)
  const lines = (overdue.length ? overdue : row.docs.filter((d: any) => Number(d.amount) > 0)).slice(0, 10)
    .map((d: any) => `• ${d.number ? `${docLabel(d.docType)} № ${d.number}` : 'остаток'} от ${fmtDate(d.date)} — ${fmtMoney(d.amount)} ₸, срок ${fmtDate(d.dueDate)}`)
  const from = org.current?.name ? `\n\n${org.current.name}` : ''
  const text = `Здравствуйте! Напоминаем об оплате: задолженность ${fmtMoney(row.total)} ₸` +
    (Number(row.overdue) ? `, из них просрочено ${fmtMoney(row.overdue)} ₸` : '') + `.\n${lines.join('\n')}${from}`
  window.open(`https://wa.me/${waPhone(row.phone)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
}

function exportCsv() {
  const head = ['Контрагент', 'БИН', 'Документ', 'Дата', 'Срок оплаты', 'Дней просрочки', 'Сумма']
  const out: any[][] = []
  for (const r of rows.value) for (const d of r.docs) out.push([r.name, r.bin, d.number ? `${docLabel(d.docType)} ${d.number}` : 'Остаток', fmtDate(d.date), fmtDate(d.dueDate), d.overdueDays, d.amount])
  downloadCsv(`долги-${side.value === 'customers' ? 'покупателей' : 'поставщикам'}-${date.value}`, head, out)
}

onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.kpi { background: var(--el-fill-color-light); border-radius: 8px; padding: 10px 14px; }
.k-label { color: var(--el-text-color-secondary); font-size: 12px; }
.k-val { font-size: 18px; font-weight: 600; margin-top: 2px; }
.k-sub { color: var(--el-text-color-secondary); font-size: 12px; }
.ok { color: var(--el-color-success); }
.bad { color: var(--el-color-danger); }
.warn { color: var(--el-color-warning-dark-2, #b88230); }
.cp { font-weight: 500; }
.muted { color: var(--el-text-color-secondary); }
.small { font-size: 12px; }
.docs { padding: 4px 12px 8px 48px; }
.doc { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--el-border-color-lighter); font-size: 13px; }
.doc.link { cursor: pointer; }
.doc.link:hover .d-num { color: var(--el-color-primary); }
.d-num { font-weight: 500; min-width: 190px; }
.d-sum { margin-left: auto; font-weight: 600; min-width: 110px; text-align: right; }
.neg { color: var(--el-color-success); }
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 10px; }
@media (max-width: 900px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
