<template>
  <div>
    <PageHeader title="Товары на реализации" subtitle="Товар у клиентов-комиссионеров: передали, продали по их отчёту, вернули">
      <el-button v-if="org.can('acc.doc.write')" type="primary" :icon="Plus" @click="addOpen = true">Комиссионер</el-button>
    </PageHeader>

    <div v-if="rows.length" class="kpis">
      <div class="kpi"><span class="kpi-ic" style="--c: #1769e0"><el-icon><component is="User" /></el-icon></span><div class="k-label">Комиссионеров</div><div class="k-val">{{ rows.length }}</div></div>
      <div class="kpi"><span class="kpi-ic" style="--c: #7c3aed"><el-icon><component is="Box" /></el-icon></span><div class="k-label">Товара у них (себестоимость)</div><div class="k-val">{{ fmtTenge(sum('cost')) }}</div></div>
      <div class="kpi"><span class="kpi-ic" style="--c: #23a047"><el-icon><component is="Sell" /></el-icon></span><div class="k-label">Продано за 30 дней</div><div class="k-val ok">{{ fmtTenge(sum('sold30')) }}</div></div>
      <div class="kpi"><span class="kpi-ic" style="--c: #0891b2"><el-icon><component is="List" /></el-icon></span><div class="k-label">Позиций товара</div><div class="k-val">{{ rows.reduce((a, r) => a + r.products, 0) }}</div></div>
    </div>

    <el-card shadow="never">
      <el-table :data="rows" size="small" v-loading="loading" empty-text="Комиссионеров нет — добавьте клиента, которому даёте товар на реализацию">
        <el-table-column label="Комиссионер" min-width="220"><template #default="{ row }"><b>{{ row.counterparty.name }}</b><div class="muted small">{{ row.storeName }}</div></template></el-table-column>
        <el-table-column label="Товара, шт." width="110" align="right"><template #default="{ row }">{{ fmtQty(row.qty) }}</template></el-table-column>
        <el-table-column label="Себестоимость" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.cost) }}</template></el-table-column>
        <el-table-column label="Продано за 30 дн." width="150" align="right"><template #default="{ row }">{{ Number(row.sold30) ? fmtMoney(row.sold30) : '—' }}</template></el-table-column>
        <el-table-column min-width="330" align="right">
          <template #default="{ row }">
            <el-button size="small" @click="transfer(row, 'to')">Передать</el-button>
            <el-button size="small" type="primary" plain @click="openReport(row)">Отчёт о продажах</el-button>
            <el-button size="small" @click="transfer(row, 'back')">Вернуть</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">Товар у комиссионера остаётся вашим (на его складе). Выручка и долг комиссионера появляются, когда он сообщает о продажах.</div>
    </el-card>

    <el-dialog v-model="addOpen" title="Новый комиссионер" width="460px">
      <el-select v-model="newCp" filterable remote :remote-method="findCp" placeholder="Покупатель" style="width: 100%;">
        <el-option v-for="c in cps" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <div class="muted small" style="margin-top: 8px;">Для него создастся склад «На реализации: …» — туда передаётся товар.</div>
      <template #footer><el-button @click="addOpen = false">Отмена</el-button><el-button type="primary" :disabled="!newCp" :loading="busy" @click="addConsignee">Добавить</el-button></template>
    </el-dialog>

    <el-drawer v-model="repOpen" :title="`Отчёт о продажах: ${rep?.counterpartyName ?? ''}`" size="720px">
      <template v-if="rep">
        <div class="rep-head">
          <el-date-picker v-model="rep.date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 150px;" />
          <span class="muted">Вознаграждение</span><el-input v-model="rep.fee" style="width: 80px;" class="num-in" /><span class="muted">%</span>
        </div>
        <el-table :data="rep.lines" size="small" empty-text="У комиссионера нет товара">
          <el-table-column label="Товар" min-width="200"><template #default="{ row }">{{ row.name }}<div class="muted small">у него {{ fmtQty(row.qty) }} {{ row.unit }}</div></template></el-table-column>
          <el-table-column label="Продано" width="110"><template #default="{ row }"><el-input v-model="row.sold" size="small" class="num-in" placeholder="0" /></template></el-table-column>
          <el-table-column label="Цена" width="120"><template #default="{ row }"><el-input v-model="row.price" size="small" class="num-in" /></template></el-table-column>
          <el-table-column label="Сумма" width="110" align="right"><template #default="{ row }">{{ Number(row.sold) && Number(row.price) ? fmtMoney(Number(row.sold) * Number(row.price)) : '' }}</template></el-table-column>
        </el-table>
        <div class="rep-total">Итого продано на <b>{{ fmtMoney(repTotal) }} ₸</b><template v-if="Number(rep.fee)">, вознаграждение {{ fmtMoney(repTotal * Number(rep.fee) / 100) }} ₸, к получению {{ fmtMoney(repTotal * (1 - Number(rep.fee) / 100)) }} ₸</template></div>
        <el-button type="primary" :loading="busy" :disabled="!repTotal" @click="sendReport">Провести отчёт</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useOrgStore } from '@/stores/org'
import { fmtMoney, fmtQty, fmtTenge, kzToday } from '@/utils/format'
import { idem, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const rows = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const sum = (k: string) => rows.value.reduce((a, r) => a + Number(r[k] || 0), 0)

async function load() {
  loading.value = true
  try { rows.value = (await api.get('/accounting/consignment')) as any } catch (e) { showError(e) } finally { loading.value = false }
}

const addOpen = ref(false)
const newCp = ref('')
const cps = ref<any[]>([])
async function findCp(q: string) { try { cps.value = ((await api.get('/catalog/counterparties', { params: { search: q || undefined, limit: 20 } })) as any).items ?? [] } catch { cps.value = [] } }
async function addConsignee() {
  busy.value = true
  try { await api.post('/accounting/consignment', { counterpartyId: newCp.value }); addOpen.value = false; newCp.value = ''; load() } catch (e) { showError(e) } finally { busy.value = false }
}

/** Передать / вернуть — обычное перемещение с подставленными складами. */
function transfer(row: any, dir: 'to' | 'back') {
  router.push({ path: '/accounting/trade/new', query: { type: 'MOVE', ...(dir === 'to' ? { storeToId: row.storeId } : { storeId: row.storeId }) } })
}

const repOpen = ref(false)
const rep = ref<any>(null)
const repTotal = computed(() => (rep.value?.lines ?? []).reduce((a: number, l: any) => a + (Number(String(l.sold).replace(',', '.')) || 0) * (Number(String(l.price).replace(',', '.')) || 0), 0))
async function openReport(row: any) {
  rep.value = null
  repOpen.value = true
  try {
    const st: any = await api.get(`/accounting/consignment/${row.storeId}/stock`)
    rep.value = { storeId: row.storeId, counterpartyName: row.counterparty.name, date: kzToday(), fee: '0', lines: st.lines.map((l: any) => ({ ...l, sold: '', price: l.lastPrice ? String(Number(l.lastPrice)) : '' })) }
  } catch (e) { showError(e) }
}
async function sendReport() {
  busy.value = true
  try {
    const r: any = await api.post('/accounting/consignment/report', {
      storeId: rep.value.storeId, date: rep.value.date, feePercent: rep.value.fee,
      lines: rep.value.lines.filter((l: any) => Number(String(l.sold).replace(',', '.')) > 0).map((l: any) => ({ productId: l.productId, qty: l.sold, price: l.price })),
    }, idem())
    ElMessage.success(`Проведена реализация ${r.demand.number}${r.fee ? ` и вознаграждение ${r.fee.number}` : ''}`)
    repOpen.value = false
    load()
  } catch (e) { showError(e) } finally { busy.value = false }
}
onMounted(load)
</script>

<style scoped>
.muted { color: var(--fp-text-3); }
.small { font-size: 12px; }
.ok { color: var(--el-color-success); }
.hint { color: var(--fp-text-3); font-size: 12px; margin-top: 10px; }
.rep-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rep-total { margin: 14px 0; font-size: 14px; }
:deep(.num-in input) { text-align: right; }
</style>
