<template>
  <!-- FP-030: журнал складских движений (источник, количество, стоимость), сверка остатка и расхождения приёмки. -->
  <div>
    <div class="page-header"><h1>Движения товаров</h1></div>
    <el-tabs v-model="tab" @tab-change="load">
      <el-tab-pane label="Журнал движений" name="MOVES" />
      <el-tab-pane label="Расхождения приёмки" name="DISCREPANCIES" />
    </el-tabs>

    <div class="filters">
      <el-date-picker v-model="period" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" start-placeholder="С" end-placeholder="По" :clearable="true" style="width: 260px;" @change="reload" />
      <template v-if="tab === 'MOVES'">
        <div style="width: 300px;"><DimSelect dim="PRODUCT" v-model="productId" size="default" @update:model-value="reload" /></div>
        <el-select v-model="storeId" clearable placeholder="Склад" style="width: 200px;" @change="reload">
          <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-select v-model="kind" clearable placeholder="Вид движения" style="width: 210px;" @change="reload">
          <el-option v-for="(label, k) in MOVE_KINDS" :key="k" :label="label" :value="k" />
        </el-select>
        <el-button :loading="checking" @click="check">Сверить остаток с журналом</el-button>
      </template>
    </div>
    <el-alert v-if="checkResult" :type="checkResult.ok ? 'success' : 'error'" show-icon :closable="true" style="margin-bottom: 10px;" @close="checkResult = null"
      :title="checkResult.ok ? `Остаток совпадает с журналом движений (строк остатка: ${checkResult.checked})` : `Расхождений остатка с журналом: ${checkResult.mismatches.length}`" />

    <template v-if="tab === 'MOVES'">
      <div v-if="data.totals" class="totals">
        <span v-if="data.totals.opening !== null">На начало: <b>{{ data.totals.opening }}</b></span>
        <span>Изменение за период: <b>{{ data.totals.qty }}</b></span>
        <span>Движений: {{ data.total }}</span>
      </div>
      <el-table v-loading="loading" :data="data.items || []" size="small" empty-text="Движений нет">
        <el-table-column label="Дата" width="100"><template #default="{ row }">{{ fmtDate(row.occurredAt) }}</template></el-table-column>
        <el-table-column label="Документ" min-width="190">
          <template #default="{ row }">
            <el-link v-if="row.source" type="primary" @click="router.push(`/accounting/trade/${row.source.id}`)">{{ tl(row.source.docType) }} {{ row.source.number }}</el-link>
            <span v-else class="muted">{{ row.sourceType === 'BACKFILL' ? 'остаток до журнала' : row.sourceType }}</span>
            <div class="muted">{{ row.sourceLine ? `строка ${row.sourceLine}` : '' }}{{ row.sourceVersion ? ` · версия ${row.sourceVersion}` : '' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="Вид" width="190">
          <template #default="{ row }">
            {{ MOVE_KINDS[row.kind] ?? row.kind }}
            <el-tag v-if="row.reversesId" size="small" type="info">встречное</el-tag>
            <el-tag v-else-if="row.reversed" size="small" type="warning">отменено</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Товар" min-width="200" show-overflow-tooltip><template #default="{ row }">{{ row.product?.name ?? row.productId }}</template></el-table-column>
        <el-table-column label="Склад" width="150" show-overflow-tooltip><template #default="{ row }">{{ row.store?.name ?? row.storeId }}</template></el-table-column>
        <el-table-column label="Количество" width="110" align="right"><template #default="{ row }"><b :class="Number(row.qty) < 0 ? 'neg' : 'pos'">{{ Number(row.qty) > 0 ? '+' : '' }}{{ row.qty }}</b></template></el-table-column>
        <el-table-column v-if="withValue" label="Стоимость, ₸" width="170" align="right">
          <template #default="{ row }">
            {{ row.value === null ? '—' : fmtMoney(row.value) }}
            <div v-if="row.valueBasis" class="muted">{{ VALUE_BASIS[row.valueBasis] ?? row.valueBasis }}</div>
          </template>
        </el-table-column>
        <el-table-column label="Причина" min-width="140" show-overflow-tooltip><template #default="{ row }">{{ row.reason ?? '' }}</template></el-table-column>
      </el-table>
      <el-pagination v-if="data.total > limit" style="margin-top: 10px;" layout="prev, pager, next, total" :total="data.total" :page-size="limit" v-model:current-page="page" @current-change="load" />
    </template>

    <template v-else>
      <div v-if="disc.claimAmount" class="totals">Сумма претензий поставщикам: <b>{{ fmtMoney(disc.claimAmount) }} ₸</b></div>
      <el-table v-loading="loading" :data="discRows" size="small" empty-text="Расхождений при приёмке нет">
        <el-table-column label="Поступление" min-width="170">
          <template #default="{ row }">
            <el-link type="primary" @click="router.push(`/accounting/trade/${row.doc.id}`)">{{ row.doc.number }}</el-link>
            <div class="muted">{{ fmtDate(row.doc.date) }} · {{ row.doc.counterparty?.name }}</div>
          </template>
        </el-table-column>
        <el-table-column label="Товар" min-width="200" show-overflow-tooltip><template #default="{ row }">{{ row.product?.name }}</template></el-table-column>
        <el-table-column label="По документу" width="110" align="right" prop="expected" />
        <el-table-column label="Принято" width="90" align="right" prop="accepted" />
        <el-table-column label="Отказ" width="80" align="right"><template #default="{ row }">{{ Number(row.rejected) ? row.rejected : '' }}</template></el-table-column>
        <el-table-column label="Недостача / излишек" width="150" align="right">
          <template #default="{ row }"><span v-if="Number(row.shortage)" class="neg">−{{ row.shortage }}</span><span v-if="Number(row.surplus)" class="pos">+{{ row.surplus }}</span></template>
        </el-table-column>
        <el-table-column label="Причина" min-width="170"><template #default="{ row }">{{ DISCREPANCY_REASONS[row.reason] ?? row.reason }}<div v-if="row.note" class="muted">{{ row.note }}</div></template></el-table-column>
        <el-table-column v-if="withValue" label="Претензия, ₸" width="130" align="right"><template #default="{ row }">{{ Number(row.claimAmount) ? fmtMoney(row.claimAmount) : '' }}</template></el-table-column>
      </el-table>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import DimSelect from '@/components/accounting/DimSelect.vue'
import { DISCREPANCY_REASONS, MOVE_KINDS, TRADE_TYPES, VALUE_BASIS, fmtDate, fmtMoney, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const { lang } = useI18n()
const tl = (k: string) => (TRADE_TYPES[k] ? TRADE_TYPES[k][lang.value] : k)
const withValue = computed(() => org.can('acc.reports.read'))

const tab = ref('MOVES')
const loading = ref(false)
const checking = ref(false)
const period = ref<[string, string] | null>(null)
const productId = ref<string | undefined>()
const storeId = ref<string | undefined>()
const kind = ref<string | undefined>()
const page = ref(1)
const limit = 100
const stores = ref<any[]>([])
const data = ref<any>({ items: [], total: 0 })
const disc = ref<any>({ items: [] })
const checkResult = ref<any>(null)
const discRows = computed(() => (disc.value.items || []).flatMap((d: any) => d.lines.map((l: any) => ({ ...l, doc: d }))))

function reload() { page.value = 1; load() }

async function load() {
  loading.value = true
  const [from, to] = period.value ?? []
  try {
    if (tab.value === 'MOVES') {
      data.value = (await api.get('/accounting/stock-movements', { params: { from, to, productId: productId.value, storeId: storeId.value, kind: kind.value, page: page.value, limit } })) as any
    } else {
      disc.value = (await api.get('/accounting/receipt-discrepancies', { params: { from, to } })) as any
    }
  } catch (e) { showError(e) }
  loading.value = false
}

async function check() {
  checking.value = true
  try { checkResult.value = await api.get('/accounting/stock-movements/check') } catch (e) { showError(e) }
  checking.value = false
}

onMounted(async () => {
  try { stores.value = (await api.get('/catalog/warehouses')) as any } catch (e) { showError(e) }
  await load()
})
</script>

<style scoped>
.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.totals { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 8px; color: var(--el-text-color-regular); font-size: 13px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.neg { color: var(--el-color-danger); }
.pos { color: var(--el-color-success); }
</style>
