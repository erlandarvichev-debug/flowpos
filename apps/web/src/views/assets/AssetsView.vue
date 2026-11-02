<template>
  <!-- FP-041: основные средства и НМА — список, карточка, принятие к учёту, выбытие, история амортизации. -->
  <div>
    <div class="page-header">
      <h1>Основные средства и НМА</h1>
      <el-button v-if="org.can('acc.refs.manage')" type="primary" :icon="Plus" @click="openCreate">Добавить объект</el-button>
    </div>
    <el-card>
      <div class="filters">
        <el-segmented v-model="f.kind" :options="[{ label: 'Все', value: '' }, { label: 'Основные средства', value: 'FIXED' }, { label: 'НМА', value: 'INTANGIBLE' }]" @change="load" />
        <el-select v-model="f.status" clearable placeholder="Состояние" style="width: 180px;" @change="load">
          <el-option v-for="(l, k) in STATUS" :key="k" :value="k" :label="l" />
        </el-select>
        <el-input v-model="f.search" clearable placeholder="Инв. номер, наименование" style="width: 240px;" @change="load" />
      </div>
      <el-table :data="items" v-loading="loading" size="small" style="cursor: pointer;" @row-click="(r: any) => openCard(r.id)">
        <el-table-column label="Инв. №" width="120" prop="inventoryNumber" />
        <el-table-column label="Наименование" min-width="240" prop="name" />
        <el-table-column label="Состояние" width="140"><template #default="{ row }"><el-tag :type="TAG[row.status]" size="small">{{ STATUS[row.status] }}</el-tag></template></el-table-column>
        <el-table-column label="Стоимость" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.cost) }}</template></el-table-column>
        <el-table-column label="Амортизация" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.accumulated) }}</template></el-table-column>
        <el-table-column label="Остаточная" width="140" align="right"><template #default="{ row }"><b>{{ fmtMoney(row.bookValue) }}</b></template></el-table-column>
        <el-table-column label="Срок, мес." width="100" align="right" prop="usefulLifeMonths" />
      </el-table>
    </el-card>

    <!-- Новый объект -->
    <el-dialog v-model="createDlg" title="Новый объект" width="560px">
      <el-form :model="form" label-width="200px">
        <el-form-item label="Вид"><el-segmented v-model="form.kind" :options="[{ label: 'Основное средство', value: 'FIXED' }, { label: 'НМА', value: 'INTANGIBLE' }]" /></el-form-item>
        <el-form-item label="Наименование"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Инвентарный номер"><el-input v-model="form.inventoryNumber" placeholder="присвоится автоматически" /></el-form-item>
        <el-form-item label="Первоначальная стоимость"><el-input v-model="form.cost" placeholder="без НДС к зачёту" /></el-form-item>
        <el-form-item label="Ликвидационная стоимость"><el-input v-model="form.salvage" placeholder="0" /></el-form-item>
        <el-form-item label="Срок полезного использования"><el-input-number v-model="form.usefulLifeMonths" :min="1" :max="1200" /> <span class="muted">&nbsp;месяцев</span></el-form-item>
        <el-form-item label="Счёт затрат по амортизации"><el-select v-model="form.expenseAccount" style="width: 100%;"><el-option v-for="e in EXPENSE" :key="e.v" :value="e.v" :label="e.l" /></el-select></el-form-item>
        <el-form-item label="Заводской номер"><el-input v-model="form.serialNumber" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="createDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="create">Создать</el-button></template>
    </el-dialog>

    <!-- Карточка -->
    <el-drawer v-model="cardDlg" :title="card ? `${card.inventoryNumber} · ${card.name}` : ''" size="640px">
      <template v-if="card">
        <div class="state">
          <el-tag :type="TAG[card.status]">{{ STATUS[card.status] }}</el-tag>
          <span v-if="card.acceptDoc" class="muted">принят {{ fmtDate(card.acceptDoc.date) }} (<el-link type="primary" @click="router.push(`/accounting/documents/${card.acceptDoc.id}`)">{{ card.acceptDoc.number }}</el-link>)</span>
          <span v-if="card.disposeDoc" class="muted">выбыл {{ fmtDate(card.disposeDoc.date) }} (<el-link type="primary" @click="router.push(`/accounting/documents/${card.disposeDoc.id}`)">{{ card.disposeDoc.number }}</el-link>)</span>
        </div>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="Вид">{{ card.kind === 'INTANGIBLE' ? 'НМА' : 'Основное средство' }}</el-descriptions-item>
          <el-descriptions-item label="Заводской №">{{ card.serialNumber ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="Стоимость">{{ fmtMoney(card.cost) }}</el-descriptions-item>
          <el-descriptions-item label="Ликвидационная">{{ fmtMoney(card.salvage) }}</el-descriptions-item>
          <el-descriptions-item label="Срок">{{ card.usefulLifeMonths }} мес. (прямолинейный)</el-descriptions-item>
          <el-descriptions-item label="В месяц">{{ fmtMoney(((Number(card.cost) - Number(card.salvage)) / card.usefulLifeMonths).toFixed(2)) }}</el-descriptions-item>
          <el-descriptions-item label="Счета">{{ card.assetAccount }} / {{ card.deprAccount }} → {{ card.expenseAccount }}</el-descriptions-item>
          <el-descriptions-item label="Остаточная"><b>{{ fmtMoney(card.bookValue) }}</b> (накоплено {{ fmtMoney(card.accumulated) }})</el-descriptions-item>
        </el-descriptions>
        <div class="actions" v-if="org.can('acc.doc.post')">
          <el-button v-if="card.status === 'DRAFT'" type="primary" @click="acceptDlg = true">Принять к учёту</el-button>
          <el-button v-if="card.status === 'IN_USE'" type="danger" plain @click="disposeDlg = true">Выбытие</el-button>
        </div>
        <h4>Амортизация</h4>
        <el-table :data="card.depreciation" size="small" empty-text="Не начислялась" max-height="320">
          <el-table-column label="Месяц" width="110" prop="period" />
          <el-table-column label="Начислено" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
          <el-table-column label="Накоплено" align="right"><template #default="{ row }">{{ fmtMoney(row.accumulated) }}</template></el-table-column>
          <el-table-column label="Остаточная" align="right"><template #default="{ row }">{{ fmtMoney(row.bookValue) }}</template></el-table-column>
        </el-table>
      </template>
    </el-drawer>

    <el-dialog v-model="acceptDlg" title="Принятие к учёту" width="520px">
      <el-form label-width="170px">
        <el-form-item label="Дата"><el-date-picker v-model="acc.date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Источник"><el-segmented v-model="acc.source" :options="[{ label: 'Покупка у поставщика', value: 'SUPPLIER' }, { label: 'Другое', value: 'OTHER' }]" /></el-form-item>
        <template v-if="acc.source === 'SUPPLIER'">
          <el-form-item label="Поставщик"><el-select v-model="acc.counterpartyId" filterable remote :remote-method="searchCp" style="width: 100%;"><el-option v-for="o in cpOptions" :key="o.value" :value="o.value" :label="o.label" /></el-select></el-form-item>
          <el-form-item label="НДС к зачёту"><el-input v-model="acc.vatAmount" placeholder="0" /></el-form-item>
        </template>
        <el-form-item v-else label="Счёт-источник"><el-select v-model="acc.corrAccount" style="width: 100%;"><el-option value="2930" label="2930 Незавершённое строительство" /><el-option value="1310" label="1310 Сырьё и материалы" /><el-option value="5110" label="5110 Вклад в уставный капитал" /><el-option value="6120" label="6120 Безвозмездно полученные активы" /></el-select></el-form-item>
        <p class="muted">Амортизация начнётся с месяца, следующего за датой принятия.</p>
      </el-form>
      <template #footer><el-button @click="acceptDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="doAccept">Провести</el-button></template>
    </el-dialog>

    <el-dialog v-model="disposeDlg" title="Выбытие" width="480px">
      <el-form label-width="120px">
        <el-form-item label="Дата"><el-date-picker v-model="disp.date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Основание"><el-input v-model="disp.reason" placeholder="Списание: износ / продажа / передача…" /></el-form-item>
        <p class="muted">Амортизация должна быть начислена по месяц выбытия включительно. Остаточная стоимость спишется на 7110.</p>
      </el-form>
      <template #footer><el-button @click="disposeDlg = false">Отмена</el-button><el-button type="danger" :loading="busy" @click="doDispose">Провести выбытие</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, showError, loadDimOptions } from '../accounting/acc'

const router = useRouter()
const org = useOrgStore()
const STATUS: Record<string, string> = { DRAFT: 'Не принят', IN_USE: 'В эксплуатации', DISPOSED: 'Выбыл' }
const TAG: Record<string, any> = { DRAFT: 'info', IN_USE: 'success', DISPOSED: 'warning' }
const EXPENSE = [{ v: '7030', l: '7030 Административные расходы' }, { v: '7020', l: '7020 Расходы по реализации' }, { v: '7010', l: '7010 Себестоимость' }, { v: '8110', l: '8110 Основное производство' }]
const items = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const f = ref({ kind: '', status: '', search: '' })
const createDlg = ref(false)
const form = ref<any>({})
const cardDlg = ref(false)
const card = ref<any>(null)
const acceptDlg = ref(false)
const disposeDlg = ref(false)
const today = new Date().toISOString().slice(0, 10)
const acc = ref<any>({ date: today, source: 'SUPPLIER', vatAmount: '', corrAccount: '2930' })
const disp = ref<any>({ date: today, reason: '' })
const cpOptions = ref<{ value: string; label: string }[]>([])

async function load() {
  loading.value = true
  try { items.value = (await api.get('/accounting/assets', { params: { kind: f.value.kind || undefined, status: f.value.status || undefined, search: f.value.search || undefined } })) as any } catch (e) { showError(e) }
  loading.value = false
}
function openCreate() { form.value = { kind: 'FIXED', name: '', inventoryNumber: '', cost: '', salvage: '', usefulLifeMonths: 36, expenseAccount: '7030', serialNumber: '' }; createDlg.value = true }
async function create() {
  busy.value = true
  try { const a = (await api.post('/accounting/assets', form.value)) as any; createDlg.value = false; await load(); await openCard(a.id) } catch (e) { showError(e) }
  busy.value = false
}
async function openCard(id: string) {
  try { card.value = await api.get(`/accounting/assets/${id}`); cardDlg.value = true } catch (e) { showError(e) }
}
async function searchCp(q: string) { cpOptions.value = await loadDimOptions('COUNTERPARTY', q) }
async function doAccept() {
  busy.value = true
  try { await api.post(`/accounting/assets/${card.value.id}/accept`, acc.value); acceptDlg.value = false; ElMessage.success('Объект принят к учёту'); await openCard(card.value.id); await load() } catch (e) { showError(e) }
  busy.value = false
}
async function doDispose() {
  busy.value = true
  try { await api.post(`/accounting/assets/${card.value.id}/dispose`, disp.value); disposeDlg.value = false; ElMessage.success('Выбытие проведено'); await openCard(card.value.id); await load() } catch (e) { showError(e) }
  busy.value = false
}
onMounted(() => { load(); searchCp('') })
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.state { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.actions { margin: 14px 0; display: flex; gap: 8px; }
h4 { margin: 16px 0 8px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
