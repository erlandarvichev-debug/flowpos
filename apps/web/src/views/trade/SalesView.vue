<template>
  <div>
    <div class="page-header">
      <h1>Продажи</h1>
      <el-button type="primary" :icon="Plus" @click="orderFormVisible = true">Создать заказ</el-button>
    </div>

    <el-tabs v-model="activeTab">
      <!-- ── Заказы покупателей ── -->
      <el-tab-pane label="Заказы покупателей" name="orders">
        <el-card>
          <el-table :data="orders" v-loading="loading" style="cursor:pointer;">
            <el-table-column prop="number" label="Номер" width="140" />
            <el-table-column label="Дата" width="110">
              <template #default="{ row }">{{ dayjs(row.date).format('DD.MM.YYYY') }}</template>
            </el-table-column>
            <el-table-column prop="counterparty.name" label="Покупатель" />
            <el-table-column label="Статус" width="150">
              <template #default="{ row }">
                <el-tag :type="orderStatusType[row.status]" size="small">{{ orderStatusLabel[row.status] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="Сумма" width="140" align="right">
              <template #default="{ row }">{{ formatMoney(row.totalAmount) }}</template>
            </el-table-column>
            <el-table-column label="1С" width="110">
              <template #default="{ row }">
                <SyncStatusBadge :status="row.syncStatus" />
              </template>
            </el-table-column>
          </el-table>
          <div v-if="ordersMeta.hasMore" style="text-align:center; margin-top:12px;">
            <el-button :loading="loading" @click="loadMoreOrders">Загрузить ещё</el-button>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ── Реализации ── -->
      <el-tab-pane label="Реализации" name="shipments">
        <el-card>
          <el-table :data="shipments" v-loading="loadingShipments">
            <el-table-column prop="number" label="Номер" width="140" />
            <el-table-column label="Дата" width="110">
              <template #default="{ row }">{{ dayjs(row.date).format('DD.MM.YYYY') }}</template>
            </el-table-column>
            <el-table-column prop="counterparty.name" label="Покупатель" />
            <el-table-column label="Статус" width="120">
              <template #default="{ row }">
                <el-tag :type="row.status === 'POSTED' ? 'success' : 'info'" size="small">
                  {{ row.status === 'POSTED' ? 'Проведено' : 'Черновик' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="Сумма" width="140" align="right">
              <template #default="{ row }">{{ formatMoney(row.totalAmount) }}</template>
            </el-table-column>
            <el-table-column label="1С" width="110">
              <template #default="{ row }">
                <SyncStatusBadge :status="row.syncStatus" />
              </template>
            </el-table-column>
          </el-table>
          <div v-if="shipmentsMeta.hasMore" style="text-align:center; margin-top:12px;">
            <el-button :loading="loadingShipments" @click="loadMoreShipments">Загрузить ещё</el-button>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- Диалог создания заказа покупателя -->
    <el-dialog v-model="orderFormVisible" title="Новый заказ покупателя" width="520px">
      <el-form :model="orderForm" label-width="120px">
        <el-form-item label="Покупатель">
          <el-select v-model="orderForm.counterpartyId" filterable placeholder="Выберите" style="width:100%">
            <el-option v-for="c in counterparties" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Дата">
          <el-date-picker v-model="orderForm.date" type="date" style="width:100%" value-format="YYYY-MM-DD" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="orderFormVisible = false">Отмена</el-button>
        <el-button type="primary" :loading="saving" @click="saveOrder">Создать</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'
import SyncStatusBadge from '@/components/SyncStatusBadge.vue'

const activeTab = ref('orders')
const loading = ref(false)
const loadingShipments = ref(false)
const orders = ref<any[]>([])
const shipments = ref<any[]>([])
const ordersMeta = ref({ hasMore: false, nextCursor: null as string | null })
const shipmentsMeta = ref({ hasMore: false, nextCursor: null as string | null })

const orderFormVisible = ref(false)
const saving = ref(false)
const counterparties = ref<any[]>([])
const orderForm = ref({ counterpartyId: '', date: dayjs().format('YYYY-MM-DD') })

const orderStatusLabel: Record<string, string> = {
  DRAFT: 'Черновик', CONFIRMED: 'Подтверждён',
  PARTIALLY_SHIPPED: 'Частично', SHIPPED: 'Отгружен', CANCELLED: 'Отменён',
}
const orderStatusType: Record<string, '' | 'success' | 'warning' | 'danger' | 'info' | 'primary'> = {
  DRAFT: 'info', CONFIRMED: 'primary', PARTIALLY_SHIPPED: 'warning', SHIPPED: 'success', CANCELLED: 'danger',
}

function formatMoney(v: number) {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(v || 0)
}

async function loadCounterparties() {
  if (counterparties.value.length) return
  const res = await api.get('/catalog/counterparties?limit=200') as any
  counterparties.value = res.data ?? res.items ?? []
}

async function loadOrders(cursor?: string) {
  loading.value = true
  try {
    const res = await api.get('/trade/sales-orders', { params: { limit: 50, ...(cursor ? { cursor } : {}) } }) as any
    const items = res.data ?? res.items ?? []
    orders.value = cursor ? [...orders.value, ...items] : items
    ordersMeta.value = res.meta ?? { hasMore: false, nextCursor: null }
  } finally { loading.value = false }
}

async function loadShipments(cursor?: string) {
  loadingShipments.value = true
  try {
    const res = await api.get('/trade/shipments', { params: { limit: 50, ...(cursor ? { cursor } : {}) } }) as any
    const items = res.data ?? res.items ?? []
    shipments.value = cursor ? [...shipments.value, ...items] : items
    shipmentsMeta.value = res.meta ?? { hasMore: false, nextCursor: null }
  } finally { loadingShipments.value = false }
}

function loadMoreOrders() { loadOrders(ordersMeta.value.nextCursor ?? undefined) }
function loadMoreShipments() { loadShipments(shipmentsMeta.value.nextCursor ?? undefined) }

async function saveOrder() {
  saving.value = true
  try {
    await api.post('/trade/sales-orders', { ...orderForm.value, items: [] })
    ElMessage.success('Заказ создан')
    orderFormVisible.value = false
    loadOrders()
  } catch { ElMessage.error('Ошибка') } finally { saving.value = false }
}

onMounted(() => {
  loadOrders()
  loadShipments()
  loadCounterparties()
})
</script>
