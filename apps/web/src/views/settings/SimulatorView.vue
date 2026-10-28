<template>
  <div>
    <div class="page-header">
      <h1>Симулятор 1С (тест)</h1>
      <el-tag type="warning">Только для разработки</el-tag>
    </div>

    <el-row :gutter="16">
      <!-- Создание документов -->
      <el-col :span="12">
        <el-card style="margin-bottom: 16px;">
          <template #header><b>Создать тестовые данные</b></template>
          <el-space direction="vertical" style="width: 100%;" size="large">

            <div>
              <div style="font-weight: 600; margin-bottom: 8px;">Заказ поставщику</div>
              <el-button type="primary" :loading="running.purchaseOrder" @click="createPurchaseOrder">
                Создать ЗП с 3 позициями
              </el-button>
              <el-text v-if="results.purchaseOrder" type="success" style="margin-left: 12px;">
                ✓ {{ results.purchaseOrder }}
              </el-text>
            </div>

            <div>
              <div style="font-weight: 600; margin-bottom: 8px;">Поступление товаров</div>
              <el-button type="primary" :loading="running.receipt" @click="createReceipt">
                Создать поступление
              </el-button>
              <el-text v-if="results.receipt" type="success" style="margin-left: 12px;">
                ✓ {{ results.receipt }}
              </el-text>
            </div>

            <div>
              <div style="font-weight: 600; margin-bottom: 8px;">Заказ покупателя + Отгрузка</div>
              <el-button type="primary" :loading="running.sale" @click="createSale">
                Создать продажу
              </el-button>
              <el-text v-if="results.sale" type="success" style="margin-left: 12px;">
                ✓ {{ results.sale }}
              </el-text>
            </div>

            <div>
              <div style="font-weight: 600; margin-bottom: 8px;">Кассовый чек (FlowPOS)</div>
              <el-button type="primary" :loading="running.posSale" @click="createPosSale">
                Создать розничную продажу
              </el-button>
              <el-text v-if="results.posSale" type="success" style="margin-left: 12px;">
                ✓ {{ results.posSale }}
              </el-text>
            </div>

            <div>
              <div style="font-weight: 600; margin-bottom: 8px;">Открыть кассовую смену</div>
              <el-button type="success" :loading="running.shift" @click="openShift">
                Открыть смену
              </el-button>
              <el-text v-if="results.shift" type="success" style="margin-left: 12px;">
                ✓ {{ results.shift }}
              </el-text>
            </div>

          </el-space>
        </el-card>

        <el-card>
          <template #header><b>Симулировать конфликт синхронизации</b></template>
          <p style="color: #909399; font-size: 13px; margin-bottom: 12px;">
            Помечает случайный товар как DIRTY — имитирует локальное изменение.
            Затем приходит версия из 1С → конфликт.
          </p>
          <el-button type="warning" :loading="running.conflict" @click="simulateConflict">
            Создать конфликт
          </el-button>
          <el-text v-if="results.conflict" type="warning" style="margin-left: 12px;">
            ⚠ {{ results.conflict }}
          </el-text>
        </el-card>
      </el-col>

      <!-- Лог результатов -->
      <el-col :span="12">
        <el-card style="height: 100%;">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <b>Лог операций</b>
              <el-button size="small" @click="logs = []">Очистить</el-button>
            </div>
          </template>
          <div ref="logBox" style="height: 500px; overflow-y: auto; font-family: monospace; font-size: 12px;">
            <div
              v-for="(log, i) in logs"
              :key="i"
              :style="{ color: log.type === 'error' ? '#f56c6c' : log.type === 'warn' ? '#e6a23c' : '#67c23a', marginBottom: '4px' }"
            >
              <span style="color: #909399;">{{ log.time }}</span> {{ log.msg }}
            </div>
            <div v-if="!logs.length" style="color: #c0c4cc; padding-top: 20px; text-align: center;">
              Нажмите кнопку чтобы начать симуляцию
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Текущее состояние системы -->
    <el-card style="margin-top: 16px;">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <b>Состояние системы</b>
          <el-button size="small" :icon="Refresh" @click="loadSystemState">Обновить</el-button>
        </div>
      </template>
      <el-row :gutter="16">
        <el-col :span="6" v-for="s in systemStats" :key="s.label">
          <div class="stat-card">
            <div class="stat-value" :style="{ color: s.color }">{{ s.value }}</div>
            <div class="stat-label">{{ s.label }}</div>
          </div>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'

interface LogEntry { time: string; msg: string; type: 'ok' | 'error' | 'warn' }

const logs = ref<LogEntry[]>([])
const logBox = ref<HTMLElement>()
const running = ref<Record<string, boolean>>({})
const results = ref<Record<string, string>>({})

const systemState = ref<any>({})

const systemStats = computed(() => [
  { label: 'Товаров', value: systemState.value?.items ?? '—', color: '#409eff' },
  { label: 'Заказов покупателей', value: systemState.value?.salesOrders ?? '—', color: '#67c23a' },
  { label: 'Чеков', value: systemState.value?.receipts ?? '—', color: '#e6a23c' },
  { label: 'Outbox (ожидает)', value: systemState.value?.outboxPending ?? '—', color: systemState.value?.outboxPending > 0 ? '#e6a23c' : '#67c23a' },
  { label: 'Outbox (ошибки)', value: (systemState.value?.outboxError ?? 0) + (systemState.value?.outboxDead ?? 0), color: '#f56c6c' },
  { label: 'Конфликтов', value: systemState.value?.conflicts ?? '—', color: '#f56c6c' },
])

function log(msg: string, type: LogEntry['type'] = 'ok') {
  logs.value.push({ time: dayjs().format('HH:mm:ss'), msg, type })
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  })
}

async function run(key: string, fn: () => Promise<string>) {
  running.value[key] = true
  results.value[key] = ''
  try {
    const result = await fn()
    results.value[key] = result
    log(`[${key}] ${result}`)
    await loadSystemState()
  } catch (e: any) {
    const msg = e?.message || JSON.stringify(e)
    log(`[${key}] ОШИБКА: ${msg}`, 'error')
    ElMessage.error(msg.slice(0, 80))
  } finally {
    running.value[key] = false
  }
}

async function loadSystemState() {
  try {
    const [items, orders, receipts, outbox] = await Promise.all([
      api.get('/catalog/items?limit=1') as any,
      api.get('/trade/sales-orders?limit=1') as any,
      api.get('/pos/receipts?limit=1') as any,
      api.get('/sync/outbox/status') as any,
    ])
    systemState.value = {
      items: items.total ?? 0,
      salesOrders: orders.total ?? (orders.meta ? '?' : 0),
      receipts: receipts.total ?? 0,
      outboxPending: outbox.pending ?? 0,
      outboxError: outbox.error ?? 0,
      outboxDead: outbox.dead ?? 0,
    }
  } catch { /* silent */ }
}

async function createPurchaseOrder() {
  return run('purchaseOrder', async () => {
    // Загружаем товары и контрагентов
    const [itemsRes, cpRes] = await Promise.all([
      api.get('/catalog/items?limit=5') as any,
      api.get('/catalog/counterparties?type=SUPPLIER&limit=5') as any,
    ])
    const items = (itemsRes.items ?? []).slice(0, 3)
    const supplier = (cpRes.items ?? cpRes.counterparties ?? [])[0]

    if (!items.length) throw new Error('Нет товаров в каталоге')
    if (!supplier) throw new Error('Нет поставщиков')

    log(`Создаю заказ: ${supplier.name}, ${items.length} позиций`, 'ok')

    const res = await api.post('/trade/purchase-orders', {
      counterpartyId: supplier.id,
      date: dayjs().format('YYYY-MM-DD'),
      status: 'DRAFT',
      items: items.map((it: any) => ({
        itemId: it.id,
        quantity: Math.ceil(Math.random() * 10) + 1,
        price: Math.floor(Math.random() * 5000) + 100,
      })),
    }) as any

    return `Создан ${res.number} (${res.items?.length ?? '?'} поз.)`
  })
}

async function createReceipt() {
  return run('receipt', async () => {
    const [ordersRes, whRes] = await Promise.all([
      api.get('/trade/purchase-orders?limit=5') as any,
      api.get('/catalog/warehouses?limit=1') as any,
    ])
    const order = (ordersRes.items ?? ordersRes.data ?? [])[0]
    const warehouse = (whRes.items ?? whRes.data ?? [])[0]

    if (!order) throw new Error('Нет заказов поставщику')
    if (!warehouse) throw new Error('Нет складов')

    log(`Создаю поступление по заказу ${order.number}`, 'ok')

    const res = await api.post('/trade/goods-receipts', {
      purchaseOrderId: order.id,
      counterpartyId: order.counterpartyId,
      warehouseId: warehouse.id,
      date: dayjs().format('YYYY-MM-DD'),
      status: 'POSTED',
      items: (order.items ?? []).map((it: any) => ({
        itemId: it.itemId,
        quantity: it.quantity,
        price: it.price,
      })),
    }) as any

    return `Поступление ${res.number} проведено`
  })
}

async function createSale() {
  return run('sale', async () => {
    const [itemsRes, cpRes] = await Promise.all([
      api.get('/catalog/items?limit=3') as any,
      api.get('/catalog/counterparties?type=CUSTOMER&limit=5') as any,
    ])
    const items = (itemsRes.items ?? []).slice(0, 2)
    const customer = (cpRes.items ?? cpRes.counterparties ?? [])[0]

    if (!items.length) throw new Error('Нет товаров')
    if (!customer) throw new Error('Нет покупателей')

    log(`Продажа: ${customer.name}`, 'ok')

    const res = await api.post('/trade/sales-orders', {
      counterpartyId: customer.id,
      date: dayjs().format('YYYY-MM-DD'),
      status: 'CONFIRMED',
      items: items.map((it: any) => ({
        itemId: it.id,
        quantity: 1,
        price: Math.floor(Math.random() * 8000) + 500,
      })),
    }) as any

    return `Создан ${res.number}`
  })
}

async function openShift() {
  return run('shift', async () => {
    const terminalsRes = await api.get('/pos/terminals') as any
    const terminal = (Array.isArray(terminalsRes) ? terminalsRes : terminalsRes.terminals ?? [])[0]

    if (!terminal) throw new Error('Нет касс')

    log(`Открываю смену на кассе ${terminal.name}`, 'ok')

    const res = await api.post(`/pos/terminals/${terminal.id}/open-shift`, {}) as any
    return `Смена ${res.number ?? res.id?.slice(0, 8)} открыта`
  })
}

async function createPosSale() {
  return run('posSale', async () => {
    const shiftsRes = await api.get('/pos/shifts?status=OPEN&limit=1') as any
    const shift = (shiftsRes.items ?? shiftsRes.data ?? [])[0]

    if (!shift) {
      log('Нет открытых смен, сначала откройте смену', 'warn')
      throw new Error('Нет открытых смен. Откройте смену сначала.')
    }

    const itemsRes = await api.get('/catalog/items?limit=3') as any
    const items = (itemsRes.items ?? []).slice(0, 2)

    if (!items.length) throw new Error('Нет товаров')

    const idempotencyKey = `sim-pos-${Date.now()}`
    log(`Создаю чек, смена: ${shift.id.slice(0, 8)}`, 'ok')

    const res = await api.post('/trade/pos-sale',
      {
        shiftId: shift.id,
        items: items.map((it: any) => ({
          itemId: it.id,
          barcode: it.barcodes?.[0]?.barcode,
          name: it.name,
          quantity: 1,
          price: Math.floor(Math.random() * 3000) + 200,
        })),
      },
      { headers: { 'Idempotency-Key': idempotencyKey } } as any,
    ) as any

    return `Чек ${res.number ?? res.id?.slice(0, 8)} создан`
  })
}

async function simulateConflict() {
  return run('conflict', async () => {
    // Просто выводим в лог — настоящий конфликт создаётся в sync-worker
    // когда сервер 1С возвращает изменённую запись, а у нас она DIRTY
    log('Симуляция: реальные конфликты создаёт sync-worker при pull из 1С', 'warn')
    log('Для демонстрации: перейдите в Настройки → Конфликты', 'warn')
    return 'Конфликты обрабатывает sync-worker (раздел Конфликты)'
  })
}

onMounted(loadSystemState)
</script>

<style scoped>
.stat-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 16px;
  text-align: center;
}
.stat-value { font-size: 22px; font-weight: 600; }
.stat-label { font-size: 12px; color: #909399; margin-top: 4px; }
</style>
