<template>
  <div>
    <PageHeader title="Производство" subtitle="Техкарты и выпуск продукции: сырьё списывается, продукция приходуется по его себестоимости">
      <el-button v-if="tab === 'orders' && org.can('acc.doc.write')" type="primary" :icon="Plus" @click="openOrder()">Выпуск</el-button>
      <el-button v-if="tab === 'recipes' && org.can('acc.doc.write')" type="primary" :icon="Plus" @click="openRecipe()">Техкарта</el-button>
    </PageHeader>

    <el-card shadow="never">
      <el-tabs v-model="tab">
        <el-tab-pane label="Выпуски" name="orders">
          <div class="filters">
            <el-radio-group v-model="status" @change="loadOrders">
              <el-radio-button value="">Все</el-radio-button>
              <el-radio-button value="PLANNED">В плане</el-radio-button>
              <el-radio-button value="DONE">Выпущено</el-radio-button>
              <el-radio-button value="CANCELLED">Отменено</el-radio-button>
            </el-radio-group>
          </div>
          <el-table :data="orders" size="small" v-loading="loading" empty-text="Выпусков пока нет — создайте техкарту и выпуск" class="clickable" @row-click="openOrder">
            <el-table-column label="Номер" width="150"><template #default="{ row }"><span class="num">{{ row.number }}</span></template></el-table-column>
            <el-table-column label="Дата" width="105"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
            <el-table-column label="Продукция" min-width="220"><template #default="{ row }">{{ row.product.name }}</template></el-table-column>
            <el-table-column label="Кол-во" width="110" align="right"><template #default="{ row }">{{ fmtQty(row.qty) }} {{ row.product.unit }}</template></el-table-column>
            <el-table-column label="Склад" min-width="140"><template #default="{ row }">{{ row.store?.name }}</template></el-table-column>
            <el-table-column label="Себестоимость" width="140" align="right">
              <template #default="{ row }"><template v-if="row.cost">{{ fmtMoney(row.cost) }}<div class="muted small">{{ fmtMoney(Number(row.cost) / Number(row.qty)) }} за ед.</div></template><span v-else class="muted">—</span></template>
            </el-table-column>
            <el-table-column label="Статус" width="120"><template #default="{ row }"><el-tag size="small" :type="ST[row.status].type">{{ ST[row.status].label }}</el-tag></template></el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="Техкарты" name="recipes">
          <el-table :data="recipes" size="small" v-loading="loading" empty-text="Техкарт нет — опишите, из чего делается продукция" class="clickable" @row-click="openRecipe">
            <el-table-column label="Техкарта" min-width="200" prop="name" />
            <el-table-column label="Продукция" min-width="200"><template #default="{ row }">{{ row.product.name }}</template></el-table-column>
            <el-table-column label="Выход" width="110" align="right"><template #default="{ row }">{{ fmtQty(row.outputQty) }} {{ row.product.unit }}</template></el-table-column>
            <el-table-column label="Состав" min-width="300"><template #default="{ row }"><span class="muted">{{ row.materials.map((m: any) => `${m.name} — ${fmtQty(m.qty)} ${m.unit}`).join('; ') }}</span></template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- Техкарта -->
    <el-dialog v-model="recipeOpen" :title="recipe.id ? 'Техкарта' : 'Новая техкарта'" width="720px">
      <el-form label-width="130px">
        <el-form-item label="Название" required><el-input v-model="recipe.name" placeholder="Например: Пирожок с мясом" /></el-form-item>
        <el-form-item label="Продукция" required><ProductPick v-model="recipe.productId" :label="recipe.productName" /></el-form-item>
        <el-form-item label="Выход"><el-input v-model="recipe.outputQty" style="width: 140px;" class="num-in" /><span class="muted" style="margin-left: 8px;">сколько продукции получается из состава ниже</span></el-form-item>
      </el-form>
      <MaterialsEditor v-model="recipe.materials" />
      <template #footer>
        <el-button @click="recipeOpen = false">Отмена</el-button>
        <el-button type="primary" :loading="busy" @click="saveRecipe">Сохранить</el-button>
      </template>
    </el-dialog>

    <!-- Выпуск -->
    <el-drawer v-model="orderOpen" :title="order.id ? `Выпуск ${order.number}` : 'Новый выпуск'" size="640px">
      <el-form label-width="130px">
        <el-form-item v-if="!order.id" label="Техкарта">
          <el-select v-model="order.recipeId" filterable clearable placeholder="Выберите техкарту" style="width: 100%;" @change="applyRecipe">
            <el-option v-for="r in recipes" :key="r.id" :label="r.name" :value="r.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Продукция"><ProductPick v-model="order.productId" :label="order.productName" :disabled="!!order.id || !!order.recipeId" /></el-form-item>
        <el-form-item label="Количество"><el-input v-model="order.qty" style="width: 140px;" class="num-in" :disabled="!editable" @change="applyRecipe" /></el-form-item>
        <el-form-item label="Склад">
          <el-select v-model="order.storeId" placeholder="Склад производства" style="width: 100%;" :disabled="!editable">
            <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Дата"><el-date-picker v-model="order.date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :disabled="!editable" /></el-form-item>
        <el-form-item label="Комментарий"><el-input v-model="order.comment" :disabled="!editable" /></el-form-item>
      </el-form>
      <h4 class="sub">Сырьё и материалы</h4>
      <MaterialsEditor v-model="order.materials" :readonly="!editable" />
      <el-alert v-if="order.status === 'DONE'" type="success" :closable="false" show-icon style="margin-top: 12px;"
        :title="`Выпущено. Себестоимость ${fmtMoney(order.cost)} ₸ (${fmtMoney(Number(order.cost) / Number(order.qty))} ₸ за единицу).`">
        <div>Документы: <el-link v-for="d in order.documents" :key="d.id" type="primary" style="margin-right: 10px;" @click="router.push(`/accounting/trade/${d.id}`)">{{ d.docType === 'LOSS' ? 'списание сырья' : 'оприходование продукции' }} {{ d.number }}</el-link></div>
      </el-alert>
      <div class="drawer-btns">
        <template v-if="editable">
          <el-button :loading="busy" @click="saveOrder(false)">Сохранить план</el-button>
          <el-button v-if="org.can('acc.doc.post')" type="primary" :loading="busy" @click="saveOrder(true)">Выпустить</el-button>
        </template>
        <el-popconfirm v-if="order.id && order.status !== 'CANCELLED' && org.can('acc.doc.cancel')" title="Отменить выпуск? Проведённые документы будут отменены." @confirm="cancelOrder">
          <template #reference><el-button type="danger" plain>Отменить выпуск</el-button></template>
        </el-popconfirm>
      </div>
      <div class="muted small" style="margin-top: 10px;">При выпуске сырьё списывается со склада (по себестоимости партий), продукция приходуется на тот же склад по сумме списанного. Не хватает сырья — выпуск не проводится.</div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElButton, ElInput, ElMessage, ElOption, ElSelect } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, fmtQty, kzToday } from '@/utils/format'
import { idem, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const ST: Record<string, { label: string; type: any }> = { PLANNED: { label: 'В плане', type: 'warning' }, DONE: { label: 'Выпущено', type: 'success' }, CANCELLED: { label: 'Отменён', type: 'info' } }
const tab = ref<'orders' | 'recipes'>('orders')
const status = ref('')
const orders = ref<any[]>([])
const recipes = ref<any[]>([])
const stores = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)

// Выбор товара с поиском по номенклатуре.
const ProductPick = defineComponent({
  props: { modelValue: String, label: String, disabled: Boolean },
  emits: ['update:modelValue'],
  setup(p, { emit }) {
    const opts = ref<any[]>([])
    const search = async (q: string) => { try { opts.value = ((await api.get('/catalog/items', { params: { search: q || undefined, limit: 20 } })) as any).items ?? [] } catch { opts.value = [] } }
    watch(() => p.modelValue, (v) => { if (v && !opts.value.some((o) => o.id === v)) opts.value = [{ id: v, name: p.label || v }, ...opts.value] }, { immediate: true })
    return () => h(ElSelect, { modelValue: p.modelValue, filterable: true, remote: true, remoteMethod: search, disabled: p.disabled, placeholder: 'Начните вводить название', style: 'width: 100%', 'onUpdate:modelValue': (v: string) => emit('update:modelValue', v), onFocus: () => !opts.value.length && search('') },
      () => opts.value.map((o) => h(ElOption, { key: o.id, label: o.name, value: o.id })))
  },
})
// Список сырья: товар + количество.
const MaterialsEditor = defineComponent({
  props: { modelValue: { type: Array as () => any[], default: () => [] }, readonly: Boolean },
  emits: ['update:modelValue'],
  setup(p, { emit }) {
    const set = (list: any[]) => emit('update:modelValue', list)
    return () => h('div', { class: 'mats' }, [
      ...p.modelValue.map((m: any, i: number) => h('div', { class: 'mat', key: i }, [
        h('div', { class: 'mat-prod' }, [h(ProductPick, { modelValue: m.productId, label: m.name, disabled: p.readonly, 'onUpdate:modelValue': (v: string) => set(p.modelValue.map((x: any, j: number) => (j === i ? { ...x, productId: v } : x))) })]),
        h(ElInput, { modelValue: m.qty, class: 'mat-qty num-in', placeholder: 'кол-во', disabled: p.readonly, 'onUpdate:modelValue': (v: string) => set(p.modelValue.map((x: any, j: number) => (j === i ? { ...x, qty: v } : x))) }),
        h('span', { class: 'mat-unit' }, m.unit || ''),
        p.readonly ? null : h(ElButton, { link: true, type: 'danger', icon: Delete, onClick: () => set(p.modelValue.filter((_: any, j: number) => j !== i)) }),
      ])),
      p.readonly ? null : h(ElButton, { size: 'small', icon: Plus, onClick: () => set([...p.modelValue, { productId: '', qty: '' }]) }, () => 'Добавить сырьё'),
    ])
  },
})

const recipeOpen = ref(false)
const recipe = ref<any>({})
function openRecipe(r?: any) {
  recipe.value = r?.id ? { id: r.id, name: r.name, productId: r.productId, productName: r.product.name, outputQty: String(Number(r.outputQty)), materials: r.materials.map((m: any) => ({ ...m, qty: String(Number(m.qty)) })) }
    : { name: '', productId: '', outputQty: '1', materials: [{ productId: '', qty: '' }] }
  recipeOpen.value = true
}
async function saveRecipe() {
  busy.value = true
  try {
    const body = { ...recipe.value, materials: recipe.value.materials.filter((m: any) => m.productId) }
    if (recipe.value.id) await api.put(`/accounting/production/recipes/${recipe.value.id}`, body); else await api.post('/accounting/production/recipes', body)
    ElMessage.success('Техкарта сохранена')
    recipeOpen.value = false
    loadRecipes()
  } catch (e) { showError(e) } finally { busy.value = false }
}

const orderOpen = ref(false)
const order = ref<any>({})
const editable = computed(() => !order.value.id || order.value.status === 'PLANNED')
async function openOrder(o?: any) {
  if (o?.id) {
    try { o = await api.get(`/accounting/production/orders/${o.id}`) } catch (e) { showError(e); return }
    order.value = { ...o, productName: o.product.name, qty: String(Number(o.qty)), date: new Date(new Date(o.date).getTime() + 5 * 3600e3).toISOString().slice(0, 10), materials: o.materials.map((m: any) => ({ ...m, qty: String(Number(m.qty)) })) }
  } else {
    order.value = { recipeId: '', productId: '', qty: '1', storeId: stores.value.length === 1 ? stores.value[0].id : '', date: kzToday(), comment: '', materials: [] }
  }
  orderOpen.value = true
}
function applyRecipe() {
  const r = recipes.value.find((x) => x.id === order.value.recipeId)
  if (!r || order.value.id) return
  const k = Number(String(order.value.qty).replace(',', '.')) / Number(r.outputQty) || 0
  order.value.productId = r.productId
  order.value.productName = r.product.name
  order.value.materials = r.materials.map((m: any) => ({ ...m, qty: String(Math.round(Number(m.qty) * k * 1000) / 1000) }))
}
async function saveOrder(complete: boolean) {
  busy.value = true
  try {
    const o = order.value
    const body = { productId: o.productId, qty: o.qty, storeId: o.storeId, date: o.date, comment: o.comment, materials: o.materials.filter((m: any) => m.productId) }
    let saved: any = o.id ? await api.put(`/accounting/production/orders/${o.id}`, body) : await api.post('/accounting/production/orders', body, idem())
    if (complete) saved = await api.post(`/accounting/production/orders/${saved.id}/complete`, {}, idem())
    ElMessage.success(complete ? `Выпущено: ${saved.number}` : `План сохранён: ${saved.number}`)
    await openOrder(saved)
    loadOrders()
  } catch (e) { showError(e) } finally { busy.value = false }
}
async function cancelOrder() {
  busy.value = true
  try { await api.post(`/accounting/production/orders/${order.value.id}/cancel`, {}, idem()); ElMessage.success('Выпуск отменён'); orderOpen.value = false; loadOrders() } catch (e) { showError(e) } finally { busy.value = false }
}

async function loadOrders() {
  loading.value = true
  try { orders.value = (await api.get('/accounting/production/orders', { params: { status: status.value || undefined } })) as any } catch (e) { showError(e) } finally { loading.value = false }
}
async function loadRecipes() { try { recipes.value = (await api.get('/accounting/production/recipes')) as any } catch (e) { showError(e) } }
onMounted(async () => {
  loadOrders()
  loadRecipes()
  try { stores.value = (await api.get('/catalog/warehouses')) as any[] } catch { stores.value = [] }
})
</script>

<style scoped>
.clickable :deep(tr) { cursor: pointer; }
.num { font-weight: 500; white-space: nowrap; }
.muted { color: var(--fp-text-3); }
.small { font-size: 12px; }
.sub { margin: 8px 0; font-size: 14px; }
.drawer-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
:deep(.mats) { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
:deep(.mat) { display: flex; gap: 8px; align-items: center; width: 100%; }
:deep(.mat-prod) { flex: 1; min-width: 0; }
:deep(.mat-qty) { width: 110px; }
:deep(.mat-unit) { width: 30px; color: var(--fp-text-3); font-size: 12px; }
:deep(.num-in input) { text-align: right; }
</style>
