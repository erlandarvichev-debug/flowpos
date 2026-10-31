<template>
  <!-- FP-027: прайс-листы (приоритет, интервал), скидки, округление, проверка чека и снимки цен для касс. -->
  <div>
    <div class="page-header"><h1>Цены и скидки</h1></div>
    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;"
      title="Цена товара берётся из действующего прайс-листа с наибольшим приоритетом; на строку чека — одна скидка (наибольший приоритет, при равном — выгоднее покупателю). Кассы получают правила неизменяемым снимком и считают так же, как здесь." />

    <el-tabs v-model="tab" @tab-change="load">
      <el-tab-pane label="Прайс-листы" name="lists">
        <div class="bar"><el-button v-if="canManage" type="primary" @click="openList()">Новый прайс-лист</el-button></div>
        <el-table :data="lists" size="small" empty-text="Прайс-листов нет" @row-click="(r: any) => openItems(r.id)" style="cursor: pointer;">
          <el-table-column prop="name" label="Название" min-width="180" />
          <el-table-column prop="priority" label="Приоритет" width="100" align="center" />
          <el-table-column label="Действует" width="210"><template #default="{ row }">{{ d(row.validFrom) }} — {{ row.validTo ? d(row.validTo) : 'бессрочно' }}</template></el-table-column>
          <el-table-column label="Магазины" width="130"><template #default="{ row }">{{ row.storeIds.length ? row.storeIds.map(storeName).join(', ') : 'все' }}</template></el-table-column>
          <el-table-column label="Цен" width="70" align="center"><template #default="{ row }">{{ row._count.items }}</template></el-table-column>
          <el-table-column label="Статус" width="120"><template #default="{ row }"><el-tag :type="STATUS_TAG[row.status]" size="small">{{ STATUS[row.status] }}</el-tag></template></el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="Скидки" name="discounts">
        <div class="bar"><el-button v-if="canManage" type="primary" @click="openDiscount()">Новая скидка</el-button></div>
        <el-table :data="discounts" size="small" empty-text="Скидок нет">
          <el-table-column prop="name" label="Название" min-width="180" />
          <el-table-column label="Скидка" width="150"><template #default="{ row }">{{ discountText(row) }}</template></el-table-column>
          <el-table-column label="Условия" min-width="200"><template #default="{ row }">{{ conditions(row) }}</template></el-table-column>
          <el-table-column prop="priority" label="Приоритет" width="100" align="center" />
          <el-table-column label="Действует" width="210"><template #default="{ row }">{{ d(row.validFrom) }} — {{ row.validTo ? d(row.validTo) : 'бессрочно' }}</template></el-table-column>
          <el-table-column label="Статус" width="160">
            <template #default="{ row }">
              <el-tag :type="STATUS_TAG[row.status]" size="small">{{ STATUS[row.status] }}</el-tag>
              <el-button v-if="canManage && row.status !== 'ARCHIVED'" link type="primary" size="small" @click="openDiscount(row)">Изменить</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="Проверка чека" name="preview">
        <el-form inline>
          <el-form-item label="Дата"><el-date-picker v-model="pv.date" type="date" value-format="YYYY-MM-DD" :clearable="false" /></el-form-item>
          <el-form-item label="Магазин"><el-select v-model="pv.storeId" clearable placeholder="любой" style="width: 200px;"><el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" /></el-select></el-form-item>
        </el-form>
        <div v-for="(l, i) in pv.lines" :key="i" class="pvline">
          <ProductPick v-model="l.productId" />
          <el-input v-model="l.qty" placeholder="Кол-во" style="width: 110px;" aria-label="Количество" />
          <el-button link type="danger" @click="pv.lines.splice(i, 1)">Убрать</el-button>
        </div>
        <div class="bar">
          <el-button @click="pv.lines.push({ productId: '', qty: '1' })">Строка</el-button>
          <el-button type="primary" :loading="busy" @click="runPreview">Рассчитать</el-button>
        </div>
        <template v-if="result">
          <el-table :data="result.lines" size="small">
            <el-table-column label="Товар" min-width="180"><template #default="{ row }">{{ productName(row.productId) }}</template></el-table-column>
            <el-table-column prop="qty" label="Кол-во" width="80" align="right" />
            <el-table-column label="Цена" width="170"><template #default="{ row }">{{ row.basePrice ?? 'нет цены' }}<div class="muted">{{ row.priceListName }}</div></template></el-table-column>
            <el-table-column prop="gross" label="Сумма" width="100" align="right" />
            <el-table-column label="Скидка" min-width="200">
              <template #default="{ row }">
                <span v-if="row.discountName">−{{ row.discount }} · {{ row.discountName }}</span><span v-else>—</span>
                <div v-for="n in row.notes" :key="n" class="muted">не применена: {{ n }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="amount" label="К оплате" width="110" align="right" />
          </el-table>
          <el-descriptions :column="5" border size="small" style="margin-top: 10px;">
            <el-descriptions-item label="Сумма">{{ result.gross }}</el-descriptions-item>
            <el-descriptions-item label="Скидки">{{ result.discount }}</el-descriptions-item>
            <el-descriptions-item label="Итог">{{ result.total }}</el-descriptions-item>
            <el-descriptions-item label="Округление">{{ result.rounding }}</el-descriptions-item>
            <el-descriptions-item label="К оплате"><b>{{ result.payable }}</b></el-descriptions-item>
          </el-descriptions>
          <el-alert v-if="result.missing.length" type="warning" :closable="false" show-icon style="margin-top: 8px;" :title="`Нет цены на дату: ${result.missing.map(productName).join(', ')}`" />
        </template>
      </el-tab-pane>

      <el-tab-pane label="Снимки для касс" name="snapshots">
        <el-form inline>
          <el-form-item label="Магазин"><el-select v-model="snap.storeId" clearable placeholder="все магазины" style="width: 200px;"><el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" /></el-select></el-form-item>
          <el-form-item label="Горизонт, дней"><el-input-number v-model="snap.horizonDays" :min="0" :max="31" /></el-form-item>
          <el-form-item><el-button v-if="canManage" type="primary" :loading="busy" @click="publish">Опубликовать</el-button></el-form-item>
        </el-form>
        <div class="muted" style="margin-bottom: 8px;">Снимок неизменяем: изменения цен и скидок попадают на кассы только новой версией. Касса без своего снимка магазина получает общий.</div>
        <el-table :data="snapshots" size="small" empty-text="Снимков ещё нет">
          <el-table-column label="Магазин" min-width="160"><template #default="{ row }">{{ row.storeKey === '*' ? 'все магазины' : storeName(row.storeKey) }}</template></el-table-column>
          <el-table-column prop="version" label="Версия" width="80" align="center" />
          <el-table-column label="Покрывает" width="210"><template #default="{ row }">{{ d(row.validFrom) }} — {{ d(row.horizonTo) }}</template></el-table-column>
          <el-table-column label="SHA-256" min-width="160"><template #default="{ row }"><code>{{ row.hash.slice(0, 16) }}…</code></template></el-table-column>
          <el-table-column label="Опубликован" width="150"><template #default="{ row }">{{ dt(row.createdAt) }}</template></el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="Округление" name="settings">
        <el-form label-width="220px" style="max-width: 560px;" :disabled="!canManage">
          <el-form-item label="Шаг округления итога чека">
            <el-select v-model="settings.receiptStep" style="width: 220px;">
              <el-option label="без округления (0,01 ₸)" value="0.01" />
              <el-option label="до 1 ₸" value="1.00" />
              <el-option label="до 5 ₸" value="5.00" />
              <el-option label="до 10 ₸" value="10.00" />
            </el-select>
          </el-form-item>
          <el-form-item label="Режим">
            <el-radio-group v-model="settings.receiptMode">
              <el-radio-button value="HALF_UP">математический</el-radio-button>
              <el-radio-button value="DOWN">в пользу покупателя</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item><el-button type="primary" :loading="busy" @click="saveSettings">Сохранить</el-button></el-form-item>
        </el-form>
        <div class="muted">Строки чека всегда считаются до тиына; округляется только итог, разница показывается отдельной суммой.</div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="listOpen" :title="listForm.id ? 'Прайс-лист' : 'Новый прайс-лист'" width="540px">
      <el-form label-width="150px">
        <el-form-item label="Название" required><el-input v-model="listForm.name" placeholder="Розница / Акция недели" /></el-form-item>
        <el-form-item label="Приоритет"><el-input-number v-model="listForm.priority" :min="-1000" :max="1000" /><span class="muted" style="margin-left: 8px;">больше — важнее</span></el-form-item>
        <el-form-item label="Действует с" required><el-date-picker v-model="listForm.validFrom" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Действует по"><el-date-picker v-model="listForm.validTo" type="date" value-format="YYYY-MM-DD" placeholder="бессрочно" /></el-form-item>
        <el-form-item label="Магазины"><el-select v-model="listForm.storeIds" multiple placeholder="все магазины" style="width: 100%;"><el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="listOpen = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="saveList">Сохранить</el-button></template>
    </el-dialog>

    <el-drawer :model-value="!!items" size="min(760px, 100%)" :title="items ? `${items.name} · приоритет ${items.priority}` : ''" @close="items = null">
      <template v-if="items">
        <div class="bar">
          <el-tag :type="STATUS_TAG[items.status]">{{ STATUS[items.status] }}</el-tag>
          <span class="muted">{{ d(items.validFrom) }} — {{ items.validTo ? d(items.validTo) : 'бессрочно' }}</span>
          <template v-if="canManage && items.status !== 'ARCHIVED'">
            <el-button size="small" @click="openList(items)">Изменить</el-button>
            <el-button v-if="items.status === 'DRAFT'" size="small" type="success" @click="setStatus('ACTIVE')">Включить</el-button>
            <el-button v-if="items.status === 'ACTIVE'" size="small" @click="setStatus('DRAFT')">Выключить</el-button>
            <el-button size="small" type="danger" plain @click="setStatus('ARCHIVED')">В архив</el-button>
          </template>
        </div>
        <el-table :data="items.items" size="small" empty-text="Цен нет">
          <el-table-column label="Товар" min-width="200"><template #default="{ row }">{{ productName(row.productId) }}</template></el-table-column>
          <el-table-column label="От кол-ва" width="100" align="right"><template #default="{ row }">{{ Number(row.minQty) }}</template></el-table-column>
          <el-table-column label="Цена" width="110" align="right"><template #default="{ row }">{{ Number(row.price).toFixed(2) }}</template></el-table-column>
          <el-table-column v-if="canManage && items.status !== 'ARCHIVED'" width="80"><template #default="{ row }"><el-button link type="danger" size="small" @click="removeItem(row)">Убрать</el-button></template></el-table-column>
        </el-table>
        <div v-if="canManage && items.status !== 'ARCHIVED'" class="pvline" style="margin-top: 12px;">
          <ProductPick v-model="itemForm.productId" />
          <el-input v-model="itemForm.price" placeholder="Цена" style="width: 110px;" aria-label="Цена" />
          <el-input v-model="itemForm.minQty" placeholder="От кол-ва" style="width: 100px;" aria-label="Порог количества" />
          <el-button type="primary" :loading="busy" @click="addItem">Сохранить цену</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="discOpen" :title="discForm.id ? 'Скидка' : 'Новая скидка'" width="600px">
      <el-form label-width="170px">
        <el-form-item label="Название" required><el-input v-model="discForm.name" /></el-form-item>
        <el-form-item label="Вид">
          <el-radio-group v-model="discForm.kind">
            <el-radio-button value="PERCENT">процент</el-radio-button>
            <el-radio-button value="AMOUNT">сумма на единицу</el-radio-button>
            <el-radio-button value="FIXED_PRICE">цена</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="discForm.kind === 'PERCENT' ? 'Процент' : discForm.kind === 'AMOUNT' ? 'Сумма, ₸' : 'Цена, ₸'" required><el-input v-model="discForm.value" style="width: 140px;" /></el-form-item>
        <el-form-item label="Приоритет"><el-input-number v-model="discForm.priority" :min="-1000" :max="1000" /></el-form-item>
        <el-form-item label="Товары"><ProductPick v-model="discForm.productIds" multiple placeholder="все товары" /></el-form-item>
        <el-form-item label="Группы"><el-select v-model="discForm.groupIds" multiple placeholder="—" style="width: 100%;"><el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" /></el-select></el-form-item>
        <el-form-item label="От количества в строке"><el-input v-model="discForm.minQty" style="width: 140px;" /></el-form-item>
        <el-form-item label="При чеке от, ₸"><el-input v-model="discForm.minReceiptAmount" style="width: 140px;" /></el-form-item>
        <el-form-item label="Действует с" required><el-date-picker v-model="discForm.validFrom" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="Действует по"><el-date-picker v-model="discForm.validTo" type="date" value-format="YYYY-MM-DD" placeholder="бессрочно" /></el-form-item>
        <el-form-item label="Магазины"><el-select v-model="discForm.storeIds" multiple placeholder="все магазины" style="width: 100%;"><el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" /></el-select></el-form-item>
        <el-form-item label="Статус"><el-select v-model="discForm.status"><el-option v-for="(l, k) in STATUS" :key="k" :label="l" :value="k" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="discOpen = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="saveDiscount">Сохранить</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, provide } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'
import ProductPick from './ProductPick.vue'

const org = useOrgStore()
const canManage = computed(() => org.can('catalog.manage'))
const tab = ref('lists')
const busy = ref(false)
// Локальная дата пользователя (toISOString дал бы вчерашнюю дату после полуночи по Алматы).
const today = new Date().toLocaleDateString('sv-SE')
const STATUS: Record<string, string> = { DRAFT: 'черновик', ACTIVE: 'действует', ARCHIVED: 'в архиве' }
const STATUS_TAG: Record<string, 'info' | 'success' | 'warning'> = { DRAFT: 'warning', ACTIVE: 'success', ARCHIVED: 'info' }
const d = (v: string) => new Date(v).toLocaleDateString('ru-RU', { timeZone: 'UTC' })
const dt = (v: string) => new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })

const lists = ref<any[]>([])
const discounts = ref<any[]>([])
const snapshots = ref<any[]>([])
const stores = ref<any[]>([])
const groups = ref<any[]>([])
/** Имена товаров, встреченных на экране (подбор товара пополняет этот справочник). */
const names = reactive<Record<string, string>>({})
provide('pricingProductNames', names)
const productName = (id: string) => names[id] ?? id.slice(0, 8)
const storeName = (id: string) => stores.value.find((s) => s.id === id)?.name ?? id.slice(0, 8)

async function rememberNames(ids: string[]) {
  const missing = [...new Set(ids)].filter((id) => id && !names[id])
  await Promise.all(missing.map(async (id) => { try { names[id] = ((await api.get(`/catalog/items/${id}`)) as any).name } catch { /* нет доступа */ } }))
}

async function load() {
  try {
    if (!stores.value.length) {
      stores.value = (await api.get('/catalog/warehouses').catch(() => [])) as any
      groups.value = (await api.get('/catalog/items/groups').catch(() => [])) as any
    }
    if (tab.value === 'lists') lists.value = (await api.get('/pricing/price-lists')) as any
    if (tab.value === 'discounts') {
      discounts.value = (await api.get('/pricing/discounts')) as any
      await rememberNames(discounts.value.flatMap((x) => x.productIds))
    }
    if (tab.value === 'snapshots') snapshots.value = (await api.get('/pricing/snapshots')) as any
    if (tab.value === 'settings') Object.assign(settings, await api.get('/pricing/settings'))
  } catch (e) { showError(e) }
}

const discountText = (r: any) => (r.kind === 'PERCENT' ? `−${Number(r.value)}%` : r.kind === 'AMOUNT' ? `−${Number(r.value).toFixed(2)} ₸ за ед.` : `цена ${Number(r.value).toFixed(2)} ₸`)
function conditions(r: any) {
  const c: string[] = []
  if (r.productIds.length) c.push(r.productIds.map(productName).join(', '))
  if (r.groupIds.length) c.push(`группы: ${r.groupIds.map((g: string) => groups.value.find((x: any) => x.id === g)?.name ?? '…').join(', ')}`)
  if (!r.productIds.length && !r.groupIds.length) c.push('все товары')
  if (r.minQty) c.push(`от ${Number(r.minQty)} шт.`)
  if (r.minReceiptAmount) c.push(`чек от ${Number(r.minReceiptAmount).toFixed(2)} ₸`)
  if (r.storeIds.length) c.push(`магазины: ${r.storeIds.map(storeName).join(', ')}`)
  return c.join(' · ')
}

async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  busy.value = true
  try {
    const r = await fn()
    if (ok) ElMessage.success(ok)
    return r
  } catch (e) { showError(e) } finally { busy.value = false }
}

// Прайс-листы
const listOpen = ref(false)
const listForm = ref<any>({})
function openList(l?: any) {
  listForm.value = l ? { id: l.id, name: l.name, priority: l.priority, validFrom: l.validFrom.slice(0, 10), validTo: l.validTo?.slice(0, 10) ?? null, storeIds: [...l.storeIds] } : { name: '', priority: 0, validFrom: today, validTo: null, storeIds: [] }
  listOpen.value = true
}
async function saveList() {
  const { id, ...b } = listForm.value
  const r: any = await run(() => (id ? api.put(`/pricing/price-lists/${id}`, b) : api.post('/pricing/price-lists', b)), 'Прайс-лист сохранён')
  if (!r) return
  listOpen.value = false
  await load()
  await openItems(r.id)
}
const items = ref<any>(null)
const itemForm = reactive({ productId: '', price: '', minQty: '1' })
async function openItems(id: string) {
  try {
    items.value = await api.get(`/pricing/price-lists/${id}`)
    await rememberNames(items.value.items.map((i: any) => i.productId))
  } catch (e) { showError(e) }
}
async function addItem() {
  if (!itemForm.productId) return ElMessage.warning('Выберите товар')
  const r = await run(() => api.post(`/pricing/price-lists/${items.value.id}/items`, { upsert: [{ productId: itemForm.productId, price: itemForm.price, minQty: itemForm.minQty || '1' }] }), 'Цена сохранена')
  if (r) { items.value = r; Object.assign(itemForm, { productId: '', price: '', minQty: '1' }); load() }
}
async function removeItem(row: any) {
  const r = await run(() => api.post(`/pricing/price-lists/${items.value.id}/items`, { remove: [{ productId: row.productId, minQty: row.minQty }] }))
  if (r) { items.value = r; load() }
}
async function setStatus(status: string) {
  const r = await run(() => api.put(`/pricing/price-lists/${items.value.id}`, { status }), STATUS[status])
  if (r) { await openItems(items.value.id); load() }
}

// Скидки
const discOpen = ref(false)
const discForm = ref<any>({})
function openDiscount(r?: any) {
  discForm.value = r
    ? { id: r.id, name: r.name, kind: r.kind, value: String(Number(r.value)), priority: r.priority, productIds: [...r.productIds], groupIds: [...r.groupIds], minQty: r.minQty ? String(Number(r.minQty)) : '', minReceiptAmount: r.minReceiptAmount ? String(Number(r.minReceiptAmount)) : '', validFrom: r.validFrom.slice(0, 10), validTo: r.validTo?.slice(0, 10) ?? null, storeIds: [...r.storeIds], status: r.status }
    : { name: '', kind: 'PERCENT', value: '', priority: 0, productIds: [], groupIds: [], minQty: '', minReceiptAmount: '', validFrom: today, validTo: null, storeIds: [], status: 'DRAFT' }
  discOpen.value = true
}
async function saveDiscount() {
  const { id, ...b } = discForm.value
  const r = await run(() => (id ? api.put(`/pricing/discounts/${id}`, b) : api.post('/pricing/discounts', b)), 'Скидка сохранена')
  if (r) { discOpen.value = false; load() }
}

// Проверка чека
const pv = reactive<{ date: string; storeId: string | null; lines: { productId: string; qty: string }[] }>({ date: today, storeId: null, lines: [{ productId: '', qty: '1' }] })
const result = ref<any>(null)
async function runPreview() {
  const lines = pv.lines.filter((l) => l.productId)
  if (!lines.length) return ElMessage.warning('Выберите товар')
  const r = await run(() => api.post('/pricing/preview', { date: pv.date, storeId: pv.storeId, lines }))
  if (r) result.value = r
}

// Снимки
const snap = reactive<{ storeId: string | null; horizonDays: number }>({ storeId: null, horizonDays: 7 })
async function publish() {
  const r: any = await run(() => api.post('/pricing/snapshots', snap))
  if (!r) return
  ElMessage.success(r.unchanged ? `Изменений нет — у касс уже версия ${r.version}` : `Опубликована версия ${r.version}`)
  load()
}

// Округление
const settings = reactive({ receiptStep: '0.01', receiptMode: 'HALF_UP' })
async function saveSettings() {
  const r: any = await run(() => api.put('/pricing/settings', settings), 'Округление сохранено')
  if (r) Object.assign(settings, r)
}

onMounted(load)
</script>

<style scoped>
.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.pvline { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
