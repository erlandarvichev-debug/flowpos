<template>
  <div>
    <div class="page-header"><PageIcon />
      <div>
        <h1>Кассы</h1>
        <div class="sub">Кассы магазинов: к какому складу привязаны и открыта ли смена</div>
      </div>
      <el-button v-if="canManage" type="primary" :icon="Plus" @click="openForm">Добавить кассу</el-button>
    </div>

    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" style="margin-bottom: 12px" />

    <div class="grid" v-loading="loading">
      <el-card v-for="t in terminals" :key="t.id" shadow="never" class="term">
        <div class="head">
          <div>
            <div class="name">{{ t.name }}</div>
            <div class="code">Код: {{ t.code }}</div>
          </div>
          <el-tag :type="active[t.id] ? 'success' : 'info'" effect="light">{{ active[t.id] ? 'Смена открыта' : 'Смена закрыта' }}</el-tag>
        </div>
        <div class="store"><el-icon><House /></el-icon> {{ t.store?.name || 'Склад не указан' }}</div>
        <div class="btns">
          <el-button v-if="!active[t.id]" size="small" type="primary" @click="openShift(t)">Открыть смену</el-button>
          <el-button size="small" @click="router.push({ path: '/pos/shifts', query: { terminalId: t.id } })">Смены</el-button>
        </div>
      </el-card>
    </div>
    <el-empty v-if="!loading && !error && !terminals.length" description="Касс пока нет" :image-size="80" />

    <el-dialog v-model="formVisible" title="Новая касса" width="440px">
      <el-form :model="form" label-width="110px" @submit.prevent>
        <el-form-item label="Название" required><el-input v-model="form.name" placeholder="Например, Касса 1 — ТЦ Мега" /></el-form-item>
        <el-form-item label="Код"><el-input v-model="form.code" placeholder="Необязательно — присвоится сам" /></el-form-item>
        <el-form-item label="Склад">
          <el-select v-model="form.storeId" placeholder="Склад, с которого продаёт касса" clearable style="width: 100%">
            <el-option v-for="w in stores" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" :loading="saving" :disabled="!form.name.trim()" @click="save">Создать</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { House, Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'

const router = useRouter()
const org = useOrgStore()
const canManage = computed(() => org.can('pos.manage'))
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const terminals = ref<any[]>([])
const stores = ref<any[]>([])
const active = reactive<Record<string, boolean>>({})
const formVisible = ref(false)
const form = ref({ name: '', code: '', storeId: '' as string | undefined })

async function load() {
  loading.value = true
  error.value = ''
  try {
    terminals.value = (await api.get('/pos/terminals')) as any[]
    const open = (await api.get('/pos/shifts', { params: { status: 'OPEN', limit: 200 } })) as any
    for (const k of Object.keys(active)) delete active[k]
    for (const s of open.shifts ?? []) active[s.terminalId] = true
  } catch (e: any) {
    error.value = e?.message || 'Не удалось загрузить кассы'
  } finally {
    loading.value = false
  }
}

function openForm() {
  form.value = { name: '', code: '', storeId: undefined }
  formVisible.value = true
}

async function openShift(t: any) {
  try {
    await api.post(`/pos/terminals/${t.id}/open-shift`, { openBalance: 0 })
    ElMessage.success(`Смена открыта на кассе «${t.name}»`)
    active[t.id] = true
  } catch (e: any) { ElMessage.error(e?.message || 'Не удалось открыть смену') }
}

async function save() {
  saving.value = true
  try {
    await api.post('/pos/terminals', { name: form.value.name.trim(), code: form.value.code.trim() || undefined, storeId: form.value.storeId || undefined })
    ElMessage.success('Касса создана')
    formVisible.value = false
    await load()
  } catch (e: any) {
    ElMessage.error(e?.message || 'Не удалось создать кассу')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  load()
  try { stores.value = ((await api.get('/catalog/warehouses')) as any[]).filter((w) => !w.deleted && !w.isTransit) } catch { /* без списка складов */ }
})
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.sub { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; min-height: 60px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.name { font-size: 17px; font-weight: 600; }
.code { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 2px; }
.store { margin: 14px 0; color: var(--el-text-color-regular); display: flex; align-items: center; gap: 6px; font-size: 13px; }
.btns { display: flex; gap: 8px; }
</style>
