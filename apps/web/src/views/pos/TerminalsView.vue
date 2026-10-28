<template>
  <div>
    <div class="page-header">
      <h1>Кассы (FlowPOS)</h1>
      <el-button type="primary" :icon="Plus" @click="formVisible = true">Добавить кассу</el-button>
    </div>

    <el-row :gutter="16" v-loading="loading">
      <el-col :span="8" v-for="t in terminals" :key="t.id">
        <el-card class="terminal-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <div style="font-size: 18px; font-weight: 600; margin-bottom: 4px;">{{ t.name }}</div>
              <el-text type="info" size="small">Код: {{ t.code }}</el-text>
            </div>
            <el-tag :type="t.isActive ? 'success' : 'danger'">
              {{ t.isActive ? 'Активна' : 'Неактивна' }}
            </el-tag>
          </div>
          <el-divider />
          <el-text size="small" type="info">Склад: {{ t.warehouse?.name || '—' }}</el-text>
          <div style="margin-top: 12px;">
            <el-button size="small" type="primary" @click="openShift(t)">Открыть смену</el-button>
            <el-button size="small" @click="viewShifts(t)">Смены</el-button>
          </div>
          <div style="margin-top: 8px;">
            <el-text size="small" type="info">API Key: </el-text>
            <el-text size="small" style="font-family: monospace; font-size: 11px;">{{ t.apiKey }}</el-text>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="formVisible" title="Новая касса" width="440px">
      <el-form :model="form" label-width="120px">
        <el-form-item label="Название"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Код"><el-input v-model="form.code" /></el-form-item>
        <el-form-item label="Склад">
          <el-select v-model="form.warehouseId" placeholder="Выберите склад" clearable>
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="save" :loading="saving">Создать</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'

const loading = ref(false)
const saving = ref(false)
const terminals = ref<any[]>([])
const warehouses = ref<any[]>([])
const formVisible = ref(false)
const form = ref<any>({ name: '', code: '', warehouseId: '' })

async function load() {
  loading.value = true
  const [t, w] = await Promise.all([api.get('/pos/terminals'), api.get('/catalog/warehouses')]) as any[]
  terminals.value = t
  warehouses.value = w
  loading.value = false
}

async function openShift(t: any) {
  try {
    await api.post(`/pos/terminals/${t.id}/open-shift`, { openBalance: 0 })
    ElMessage.success(`Смена открыта на кассе ${t.name}`)
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
}

function viewShifts(_t: any) {}

async function save() {
  saving.value = true
  try {
    await api.post('/pos/terminals', form.value)
    ElMessage.success('Касса создана')
    formVisible.value = false
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  saving.value = false
}

onMounted(load)
</script>

<style scoped>
.terminal-card { margin-bottom: 16px; }
</style>
