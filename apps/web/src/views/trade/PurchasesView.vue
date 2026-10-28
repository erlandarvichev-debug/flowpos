<template>
  <div>
    <div class="page-header">
      <h1>Закупки</h1>
      <el-button type="primary" :icon="Plus" @click="openOrderForm">Создать заказ</el-button>
    </div>

    <el-tabs v-model="activeTab">
      <!-- ── Заказы поставщикам ── -->
      <el-tab-pane label="Заказы поставщикам" name="orders">
        <el-card>
          <el-table :data="orders" v-loading="loadingOrders" @row-click="(row: any) => viewOrder(row)" style="cursor:pointer;">
            <el-table-column prop="number" label="Номер" width="140" />
            <el-table-column label="Дата" width="110">
              <template #default="{ row }">{{ formatDate(row.date) }}</template>
            </el-table-column>
            <el-table-column prop="counterparty.name" label="Поставщик" />
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
            <el-button :loading="loadingOrders" @click="loadMoreOrders">Загрузить ещё</el-button>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ── Поступления ── -->
      <el-tab-pane label="Поступления" name="receipts">
        <el-card>
          <div style="margin-bottom: 12px;">
            <el-button type="primary" size="small" :icon="Plus" @click="openReceiptForm">Создать поступление</el-button>
          </div>
          <el-table :data="receipts" v-loading="loadingReceipts">
            <el-table-column prop="number" label="Номер" width="140" />
            <el-table-column label="Дата" width="110">
              <template #default="{ row }">{{ formatDate(row.date) }}</template>
            </el-table-column>
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
          <div v-if="receiptsMeta.hasMore" style="text-align:center; margin-top:12px;">
            <el-button :loading="loadingReceipts" @click="loadMoreReceipts">Загрузить ещё</el-button>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- Диалог создания заказа -->
    <el-dialog v-model="orderFormVisible" title="Новый заказ поставщику" width="560px">
      <el-form :model="orderForm" label-width="130px">
        <el-form-item label="Поставщик">
          <el-select v-model="orderForm.counterpartyId" filterable placeholder="Выберите поставщика" style="width:100%">
            <el-option v-for="c in counterparties" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Дата">
          <el-date-picker v-model="orderForm.date" type="date" style="width:100%" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="Склад">
          <el-input v-model="orderForm.warehouseId" placeholder="ID склада" />
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
const loadingOrders = ref(false)
const loadingReceipts = ref(false)
const orders = ref<any[]>([])
const receipts = ref<any[]>([])
const ordersMeta = ref({ hasMore: false, nextCursor: null as string | null })
const receiptsMeta = ref({ hasMore: false, nextCursor: null as string | null })

const orderFormVisible = ref(false)
const saving = ref(false)
const counterparties = ref<any[]>([])
const orderForm = ref({ counterpartyId: '', date: dayjs().format('YYYY-MM-DD'), warehouseId: '' })

const orderStatusLabel: Record<string, string> = {
  DRAFT: 'Черновик', CONFIRMED: 'Подтверждён',
  PARTIALLY_RECEIVED: 'Частично', RECEIVED: 'Получен', CANCELLED: 'Отменён',
}
const orderStatusType: Record<string, '' | 'success' | 'warning' | 'danger' | 'info' | 'primary'> = {
  DRAFT: 'info', CONFIRMED: 'primary',
  PARTIALLY_RECEIVED: 'warning', RECEIVED: 'success', CANCELLED: 'danger',
}

function formatDate(d: string) { return dayjs(d).format('DD.MM.YYYY') }
function formatMoney(v: number) {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', minimumFractionDigits: 0 }).format(v || 0)
}

function viewOrder(_r: any) {}
function openOrderForm() { orderFormVisible.value = true; loadCounterparties() }
function openReceiptForm() {}

async function loadCounterparties() {
  if (counterparties.value.length) return
  const res = await api.get('/catalog/counterparties?limit=200') as any
  counterparties.value = res.data ?? res.items ?? []
}

async function loadOrders(cursor?: string) {
  loadingOrders.value = true
  try {
    const params: any = { limit: 50 }
    if (cursor) params.cursor = cursor
    const res = await api.get('/trade/purchase-orders', { params }) as any
    const items = res.data ?? res.items ?? []
    orders.value = cursor ? [...orders.value, ...items] : items
    ordersMeta.value = res.meta ?? { hasMore: false, nextCursor: null }
  } finally { loadingOrders.value = false }
}

async function loadReceipts(cursor?: string) {
  loadingReceipts.value = true
  try {
    const params: any = { limit: 50 }
    if (cursor) params.cursor = cursor
    const res = await api.get('/trade/goods-receipts', { params }) as any
    const items = res.data ?? res.items ?? []
    receipts.value = cursor ? [...receipts.value, ...items] : items
    receiptsMeta.value = res.meta ?? { hasMore: false, nextCursor: null }
  } finally { loadingReceipts.value = false }
}

function loadMoreOrders() { loadOrders(ordersMeta.value.nextCursor ?? undefined) }
function loadMoreReceipts() { loadReceipts(receiptsMeta.value.nextCursor ?? undefined) }

async function saveOrder() {
  saving.value = true
  try {
    await api.post('/trade/purchase-orders', { ...orderForm.value, items: [] })
    ElMessage.success('Заказ создан')
    orderFormVisible.value = false
    loadOrders()
  } catch { ElMessage.error('Ошибка создания') } finally { saving.value = false }
}

onMounted(() => { loadOrders(); loadReceipts() })
</script>
