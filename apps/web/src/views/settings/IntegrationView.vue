<template>
  <div>
    <div class="page-header">
      <h1>Интеграция с 1С</h1>
      <el-button type="primary" :icon="Plus" @click="formVisible = true">Добавить подключение</el-button>
    </div>

    <!-- KPI карточки outbox -->
    <el-row :gutter="16" style="margin-bottom: 16px;">
      <el-col :span="4" v-for="s in outboxStats" :key="s.label">
        <div class="stat-card">
          <div class="stat-value" :style="{ color: s.color }">{{ s.value }}</div>
          <div class="stat-label">{{ s.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <!-- Подключения -->
      <el-col :span="10">
        <el-card>
          <template #header><b>Подключения к 1С</b></template>
          <div v-for="inst in instances" :key="inst.id" class="instance-item">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <b>{{ inst.name }}</b>
                <el-tag size="small" :type="inst.isActive ? 'success' : 'danger'" style="margin-left: 8px;">
                  {{ inst.isActive ? 'Активно' : 'Отключено' }}
                </el-tag>
                <el-tag size="small" type="info" style="margin-left: 4px;">{{ inst.instanceType }}</el-tag>
              </div>
              <el-button size="small" @click="triggerSync(inst)" :loading="syncingId === inst.id">
                Синхронизировать
              </el-button>
            </div>
            <el-text size="small" type="info">
              {{ inst.baseUrl }} | Синх.: {{ inst.lastSyncAt ? dayjs(inst.lastSyncAt).format('DD.MM.YY HH:mm') : 'никогда' }}
            </el-text>
          </div>
          <el-empty v-if="!instances.length" description="Нет подключений" :image-size="60" />
        </el-card>
      </el-col>

      <!-- Outbox / очередь -->
      <el-col :span="14">
        <el-card>
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <b>Outbox (очередь → 1С)</b>
              <div style="display:flex; gap:8px;">
                <el-select v-model="outboxFilter" @change="loadOutbox" size="small" style="width: 130px;" clearable placeholder="Все статусы">
                  <el-option label="Ожидает" value="PENDING" />
                  <el-option label="Ошибка" value="ERROR" />
                  <el-option label="Отправлено" value="DONE" />
                  <el-option label="Dead letter" value="DEAD" />
                </el-select>
                <el-button size="small" :icon="Refresh" @click="loadOutbox" />
              </div>
            </div>
          </template>
          <el-table :data="outbox" size="small" max-height="380" v-loading="loadingOutbox">
            <el-table-column prop="entity" label="Объект" width="100" />
            <el-table-column prop="operation" label="Операция" width="90" />
            <el-table-column label="Статус" width="110">
              <template #default="{ row }">
                <el-tag :type="outboxStatusColor[row.status]" size="small">{{ outboxStatusLabel[row.status] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="Попытки" width="70" align="center">
              <template #default="{ row }">{{ row.attempts }}</template>
            </el-table-column>
            <el-table-column label="Ошибка" min-width="160">
              <template #default="{ row }">
                <el-text size="small" type="danger" v-if="row.lastError" :title="row.lastError">
                  {{ row.lastError?.slice(0, 50) }}{{ row.lastError?.length > 50 ? '…' : '' }}
                </el-text>
              </template>
            </el-table-column>
            <el-table-column label="Создано" width="130">
              <template #default="{ row }">{{ dayjs(row.createdAt).format('DD.MM HH:mm:ss') }}</template>
            </el-table-column>
          </el-table>
          <div v-if="outboxMeta.hasMore" style="text-align:center; margin-top:8px;">
            <el-button size="small" @click="loadMoreOutbox" :loading="loadingOutbox">Загрузить ещё</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Диалог добавления подключения -->
    <el-dialog v-model="formVisible" title="Подключение к 1С" width="520px">
      <el-form :model="form" label-width="130px">
        <el-form-item label="Название"><el-input v-model="form.name" placeholder="Основная база 1С" /></el-form-item>
        <el-form-item label="Тип">
          <el-radio-group v-model="form.instanceType">
            <el-radio label="LOCAL">Локальная</el-radio>
            <el-radio label="FRESH">1С:Фреш</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="URL базы"><el-input v-model="form.baseUrl" placeholder="http://1c-server:8080" /></el-form-item>
        <el-form-item label="Код ИБ"><el-input v-model="form.infobase" placeholder="trade" /></el-form-item>
        <el-form-item label="Пользователь"><el-input v-model="form.username" /></el-form-item>
        <el-form-item label="Пароль"><el-input v-model="form.password" type="password" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="saveInstance" :loading="saving">Сохранить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'

const instances = ref<any[]>([])
const outbox = ref<any[]>([])
const outboxStatus = ref<any>({})
const outboxMeta = ref({ hasMore: false, nextCursor: null as string | null })
const loadingOutbox = ref(false)
const formVisible = ref(false)
const saving = ref(false)
const syncingId = ref<string | null>(null)
const outboxFilter = ref('')
const form = ref({ name: '', instanceType: 'LOCAL', baseUrl: '', infobase: '', username: '', password: '' })

const outboxStatusLabel: Record<string, string> = {
  PENDING: 'Ожидает', SENDING: 'Отправляется', DONE: 'Готово', ERROR: 'Ошибка', DEAD: 'Dead letter',
}
const outboxStatusColor: Record<string, '' | 'success' | 'warning' | 'danger' | 'info' | 'primary'> = {
  PENDING: 'warning', SENDING: 'primary', DONE: 'success', ERROR: 'danger', DEAD: 'danger',
}

const outboxStats = computed(() => [
  { label: 'Ожидает', value: outboxStatus.value?.pending ?? 0, color: '#e6a23c' },
  { label: 'Отправляется', value: outboxStatus.value?.sending ?? 0, color: '#409eff' },
  { label: 'Готово', value: outboxStatus.value?.done ?? 0, color: '#67c23a' },
  { label: 'Ошибка', value: outboxStatus.value?.error ?? 0, color: '#f56c6c' },
  { label: 'Dead', value: outboxStatus.value?.dead ?? 0, color: '#909399' },
])

async function load() {
  const [inst, os] = await Promise.all([
    api.get('/sync/instances'),
    api.get('/sync/outbox/status'),
  ]) as any[]
  instances.value = inst
  outboxStatus.value = os
}

async function loadOutbox(cursor?: string) {
  loadingOutbox.value = true
  try {
    const params: any = { limit: 50 }
    if (outboxFilter.value) params.status = outboxFilter.value
    if (cursor) params.cursor = cursor
    const res = await api.get('/sync/outbox', { params }) as any
    const items = res.data ?? []
    outbox.value = cursor ? [...outbox.value, ...items] : items
    outboxMeta.value = res.meta ?? { hasMore: false, nextCursor: null }
  } finally { loadingOutbox.value = false }
}

function loadMoreOutbox() { loadOutbox(outboxMeta.value.nextCursor ?? undefined) }

async function triggerSync(inst: any) {
  syncingId.value = inst.id
  try {
    await api.post(`/sync/instances/${inst.id}/sync`)
    ElMessage.success('Синхронизация запущена')
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  syncingId.value = null
}

async function saveInstance() {
  saving.value = true
  try {
    await api.post('/sync/instances', form.value)
    ElMessage.success('Подключение добавлено')
    formVisible.value = false
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  saving.value = false
}

onMounted(() => { load(); loadOutbox() })
</script>

<style scoped>
.instance-item {
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
}
.instance-item:last-child { border-bottom: none; }
.stat-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 16px;
  text-align: center;
}
.stat-value { font-size: 24px; font-weight: 600; }
.stat-label { font-size: 12px; color: #909399; margin-top: 4px; }
</style>
