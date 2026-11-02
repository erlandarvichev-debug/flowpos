<template>
  <!-- FP-035: потребность по правилам пополнения → заказы поставщикам; правила; бюджет закупок. -->
  <div>
    <div class="page-header"><h1>Потребность и закупки</h1></div>
    <el-tabs v-model="tab" @tab-change="load">
      <el-tab-pane label="Потребность" name="NEEDS" />
      <el-tab-pane label="Правила пополнения" name="RULES" />
      <el-tab-pane label="Бюджет закупок" name="BUDGET" />
    </el-tabs>

    <template v-if="tab === 'NEEDS'">
      <div class="filters">
        <el-select v-model="storeId" placeholder="Склад" style="width: 220px;" @change="load">
          <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-checkbox v-model="showAll" @change="load">показать все правила</el-checkbox>
        <el-button type="primary" :disabled="!selected.length" :loading="busy" @click="createOrders" v-if="org.can('acc.doc.write')">Создать заказы поставщикам ({{ selected.length }})</el-button>
      </div>
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 10px;"
        title="К заказу = уровень пополнения − (свободно + в заказах), когда свободно + в заказах ниже точки заказа. Свободно — остаток за вычетом резервов; в заказах — проведённые незакрытые заказы поставщикам минус принятое." />
      <el-table v-loading="loading" :data="needs" size="small" empty-text="Потребности нет (или нет правил пополнения для склада)" @selection-change="(r: any[]) => (selected = r)">
        <el-table-column type="selection" width="40" :selectable="(r: any) => Number(r.need) > 0" />
        <el-table-column label="Товар" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ row.product.name }}</template></el-table-column>
        <el-table-column label="Точка / уровень" width="130" align="right"><template #default="{ row }">{{ Number(row.minQty) }} / {{ Number(row.maxQty) }}</template></el-table-column>
        <el-table-column label="Свободно" width="100" align="right"><template #default="{ row }">{{ Number(row.free) }}<div v-if="Number(row.reserved)" class="muted">резерв {{ Number(row.reserved) }}</div></template></el-table-column>
        <el-table-column label="В заказах" width="100" align="right"><template #default="{ row }">{{ Number(row.onOrder) }}</template></el-table-column>
        <el-table-column label="К заказу" width="120"><template #default="{ row }"><el-input v-model="row.need" size="small" class="num-in" /></template></el-table-column>
        <el-table-column label="Поставщик" min-width="220"><template #default="{ row }"><DimSelect dim="COUNTERPARTY" v-model="row.supplierId" /></template></el-table-column>
        <el-table-column label="Цена" width="110" align="right"><template #default="{ row }">{{ row.price ? fmtMoney(row.price) : '—' }}</template></el-table-column>
        <el-table-column label="Сумма" width="120" align="right"><template #default="{ row }">{{ row.price ? fmtMoney(Number(row.price) * Number(row.need || 0)) : '—' }}</template></el-table-column>
      </el-table>
    </template>

    <template v-else-if="tab === 'RULES'">
      <div class="filters">
        <el-select v-model="storeId" placeholder="Склад" style="width: 220px;" @change="load">
          <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-button v-if="org.can('catalog.manage')" type="primary" @click="openRule()">Добавить правило</el-button>
      </div>
      <el-table v-loading="loading" :data="rules" size="small" empty-text="Правил нет — потребность не считается">
        <el-table-column label="Товар" min-width="240"><template #default="{ row }">{{ row.product.name }}</template></el-table-column>
        <el-table-column label="Склад" width="180"><template #default="{ row }">{{ row.store.name }}</template></el-table-column>
        <el-table-column label="Точка заказа" width="120" align="right"><template #default="{ row }">{{ Number(row.minQty) }}</template></el-table-column>
        <el-table-column label="Уровень" width="100" align="right"><template #default="{ row }">{{ Number(row.maxQty) }}</template></el-table-column>
        <el-table-column label="" width="170">
          <template #default="{ row }">
            <template v-if="org.can('catalog.manage')">
              <el-button link type="primary" size="small" @click="openRule(row)">Изменить</el-button>
              <el-button link type="danger" size="small" @click="deleteRule(row)">Удалить</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <template v-else>
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 10px;"
        title="Заказы поставщикам месяца сверх бюджета проводятся только после согласования другим сотрудником (Бухгалтерия → Согласования)." />
      <div v-if="org.can('acc.policy.manage')" class="filters">
        <el-date-picker v-model="bf.period" type="month" value-format="YYYY-MM" format="MM.YYYY" placeholder="Месяц" style="width: 140px;" />
        <el-input v-model="bf.amount" placeholder="Сумма, ₸" style="width: 160px;" />
        <el-input v-model="bf.note" placeholder="Примечание" style="width: 240px;" />
        <el-button type="primary" :loading="busy" @click="saveBudget">Сохранить бюджет</el-button>
      </div>
      <el-table v-loading="loading" :data="budgets" size="small" empty-text="Бюджетов нет — заказы без ограничения">
        <el-table-column label="Месяц" width="120" prop="period" />
        <el-table-column label="Бюджет, ₸" width="160" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
        <el-table-column label="Примечание" min-width="200" prop="note" />
      </el-table>
    </template>

    <el-dialog v-model="ruleOpen" title="Правило пополнения" width="min(520px, 96vw)">
      <el-form label-width="150px">
        <el-form-item label="Склад"><el-select v-model="rf.storeId" style="width: 100%;"><el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" /></el-select></el-form-item>
        <el-form-item label="Товар"><DimSelect dim="PRODUCT" v-model="rf.productId" :selected-label="rf.productName" size="default" /></el-form-item>
        <el-form-item label="Точка заказа"><el-input v-model="rf.minQty" /></el-form-item>
        <el-form-item label="Уровень пополнения"><el-input v-model="rf.maxQty" /></el-form-item>
        <el-form-item label="Поставщик"><DimSelect dim="COUNTERPARTY" v-model="rf.supplierId" size="default" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="ruleOpen = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="saveRule">Сохранить</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import DimSelect from '@/components/accounting/DimSelect.vue'
import { fmtMoney, idem, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const tab = ref('NEEDS')
const loading = ref(false)
const busy = ref(false)
const stores = ref<any[]>([])
const storeId = ref<string | undefined>()
const showAll = ref(false)
const needs = ref<any[]>([])
const selected = ref<any[]>([])
const rules = ref<any[]>([])
const budgets = ref<any[]>([])
const bf = ref<any>({ period: '', amount: '', note: '' })
const ruleOpen = ref(false)
const rf = ref<any>({})

async function load() {
  loading.value = true
  try {
    if (tab.value === 'NEEDS') {
      needs.value = storeId.value ? ((await api.get('/accounting/purchase-needs', { params: { storeId: storeId.value, all: showAll.value ? '1' : undefined } })) as any).items : []
    } else if (tab.value === 'RULES') {
      rules.value = (await api.get('/accounting/replenishment-rules', { params: { storeId: storeId.value } })) as any
    } else {
      budgets.value = (await api.get('/accounting/purchase-budgets')) as any
    }
  } catch (e) { showError(e) }
  loading.value = false
}

async function createOrders() {
  busy.value = true
  try {
    const r = (await api.post('/accounting/purchase-needs/orders', { storeId: storeId.value, lines: selected.value.map((x) => ({ productId: x.product.id, qty: x.need, supplierId: x.supplierId })) }, idem())) as any[]
    ElMessage.success(`Созданы заказы поставщикам: ${r.map((x) => x.number).join(', ')}`)
    if (r.length === 1) router.push(`/accounting/trade/${r[0].id}`)
    else load()
  } catch (e) { showError(e) }
  busy.value = false
}

function openRule(r?: any) {
  rf.value = r ? { storeId: r.storeId, productId: r.productId, productName: r.product.name, minQty: String(Number(r.minQty)), maxQty: String(Number(r.maxQty)), supplierId: r.supplierId ?? undefined } : { storeId: storeId.value, minQty: '', maxQty: '' }
  ruleOpen.value = true
}
async function saveRule() {
  busy.value = true
  try {
    await api.put('/accounting/replenishment-rules', rf.value)
    ElMessage.success('Правило сохранено')
    ruleOpen.value = false
    load()
  } catch (e) { showError(e) }
  busy.value = false
}
async function deleteRule(r: any) {
  try { await ElMessageBox.confirm(`Удалить правило для «${r.product.name}»?`, 'Правило пополнения', { type: 'warning', confirmButtonText: 'Удалить', cancelButtonText: 'Отмена' }) } catch { return }
  try { await api.delete(`/accounting/replenishment-rules/${r.id}`); load() } catch (e) { showError(e) }
}
async function saveBudget() {
  busy.value = true
  try {
    await api.put('/accounting/purchase-budgets', bf.value)
    ElMessage.success('Бюджет сохранён')
    bf.value = { period: '', amount: '', note: '' }
    load()
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(async () => {
  try {
    stores.value = (await api.get('/catalog/warehouses')) as any
    if (stores.value.length) storeId.value = stores.value[0].id
  } catch (e) { showError(e) }
  load()
})
</script>

<style scoped>
.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.num-in :deep(input) { text-align: right; }
</style>
