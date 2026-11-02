<template>
  <!-- Акт сверки взаиморасчётов: контрагент, период → сальдо, обороты по документам, печать. -->
  <div>
    <div class="page-header">
      <h1>Акт сверки</h1>
      <div class="actions">
        <el-select v-model="cp" filterable remote :remote-method="search" placeholder="Контрагент" style="width: 280px;" @change="load">
          <el-option v-for="o in options" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="с" end-placeholder="по" style="width: 260px;" @change="load" />
        <PrintButton v-if="r" source="RECON" :query="{ counterpartyId: cp, from: range?.[0], to: range?.[1] }" />
      </div>
    </div>
    <el-empty v-if="!r" description="Выберите контрагента и период" />
    <template v-else>
      <div class="totals">
        <div class="total"><div class="label">Сальдо на {{ fmtDate(r.period.from) }}</div><div class="value">{{ side(r.opening) }}</div></div>
        <div class="total"><div class="label">Обороты: дебет / кредит</div><div class="value">{{ fmtMoney(r.turnover.debit) }} / {{ fmtMoney(r.turnover.credit) }}</div></div>
        <div class="total main"><div class="label">Сальдо на {{ fmtDate(r.period.to) }}</div><div class="value">{{ side(r.closing) }}</div></div>
      </div>
      <el-table :data="r.rows" size="small" empty-text="Движений за период нет" @row-click="open" style="cursor: pointer;">
        <el-table-column label="Дата" width="110"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
        <el-table-column label="Документ" min-width="300" prop="document" />
        <el-table-column label="Дебет" width="160" align="right"><template #default="{ row }">{{ Number(row.debit) ? fmtMoney(row.debit) : '' }}</template></el-table-column>
        <el-table-column label="Кредит" width="160" align="right"><template #default="{ row }">{{ Number(row.credit) ? fmtMoney(row.credit) : '' }}</template></el-table-column>
      </el-table>
      <p class="muted">Дебет — долг контрагента перед нами растёт, кредит — уменьшается. Счета: {{ r.accounts.join(', ') }}.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/client'
import PrintButton from '@/components/print/PrintButton.vue'
import { fmtDate, fmtMoney, showError, loadDimOptions } from './acc'

const router = useRouter()
const cp = ref('')
const now = new Date()
const range = ref<[string, string] | null>([`${now.getFullYear()}-01-01`, now.toISOString().slice(0, 10)])
const options = ref<{ value: string; label: string }[]>([])
const r = ref<any>(null)
const side = (v: string) => (Number(v) > 0 ? `${fmtMoney(v)} — нам должны` : Number(v) < 0 ? `${fmtMoney(-Number(v))} — мы должны` : '0,00')

async function search(q: string) { options.value = await loadDimOptions('COUNTERPARTY', q) }
async function load() {
  if (!cp.value || !range.value) return
  try { r.value = await api.get('/accounting/reports/reconciliation', { params: { counterpartyId: cp.value, from: range.value[0], to: range.value[1] } }) } catch (e) { showError(e) }
}
function open(row: any) { router.push(row.sourceType === 'TRADE_DOCUMENT' ? `/accounting/trade/${row.sourceId}` : `/accounting/documents/${row.sourceId}`) }
search('')
</script>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; }
.totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 8px 0 16px; }
.total { background: var(--el-fill-color-light); border-radius: 8px; padding: 12px 16px; }
.total.main { background: var(--el-color-primary-light-9); }
.total .label { color: var(--el-text-color-secondary); font-size: 13px; }
.total .value { font-size: 18px; font-weight: 600; margin-top: 4px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 8px; }
</style>
