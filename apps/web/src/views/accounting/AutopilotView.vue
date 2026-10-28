<template>
  <div>
    <div class="page-header">
      <h1>{{ t('autopilot') }}</h1>
      <div class="actions">
        <el-button @click="load" :loading="loading">Обновить</el-button>
        <el-button v-if="org.can('acc.doc.post')" type="warning" :loading="busy" @click="resync">{{ t('resync') }}</el-button>
      </div>
    </div>

    <el-row :gutter="12" style="margin-bottom: 12px;">
      <el-col :xs="12" :md="6"><el-card><el-statistic title="Проведено торговых документов" :value="status?.postedTradeDocuments ?? 0" /></el-card></el-col>
      <el-col :xs="12" :md="6"><el-card><el-statistic title="Отражено в учёте" :value="status?.reflected ?? 0" /></el-card></el-col>
      <el-col :xs="12" :md="6"><el-card><el-statistic title="Открытых проблем" :value="status?.openIssues ?? 0" :value-style="{ color: status?.openIssues ? '#f56c6c' : '#67c23a' }" /></el-card></el-col>
      <el-col :xs="12" :md="6">
        <el-card>
          <div class="st-title">Состояние</div>
          <el-tag :type="status?.enabled ? 'success' : 'info'">{{ status?.enabled ? 'Включён' : 'Выключен в учётной политике' }}</el-tag>
          <div class="hint" v-if="status?.cursor">Сверка обмена до {{ new Date(status.cursor).toLocaleString('ru-RU') }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;"
      title="Автопилот сам отражает в учёте проведённые документы торговли, кассы и обмена (1С, МойСклад): проводки, НДС, себестоимость. Если документ отразить нельзя — он появляется здесь с объяснением, что исправить." />

    <el-card>
      <template #header>
        <div class="card-head">
          <span>{{ t('issues') }}</span>
          <el-checkbox v-model="showResolved" @change="load">Показывать решённые</el-checkbox>
        </div>
      </template>
      <el-table :data="issues" size="small" v-loading="loading" empty-text="Проблем нет — все документы отражены">
        <el-table-column :label="t('date')" width="100"><template #default="{ row }">{{ fmtDate(row.document?.date) }}</template></el-table-column>
        <el-table-column label="Документ" min-width="200">
          <template #default="{ row }">
            <el-link type="primary" @click="router.push(`/accounting/trade/${row.sourceId}`)">{{ tl(row.document?.docType) }} {{ row.document?.number || row.sourceId.slice(0, 8) }}</el-link>
          </template>
        </el-table-column>
        <el-table-column label="Что случилось" min-width="320">
          <template #default="{ row }">
            <div><el-tag size="small" type="danger" effect="plain">{{ row.code }}</el-tag> {{ row.message }}</div>
            <div v-if="row.fix" class="fix">Что сделать: {{ row.fix }}</div>
          </template>
        </el-table-column>
        <el-table-column label="Попыток" prop="attempts" width="80" align="center" />
        <el-table-column label="" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.resolvedAt" type="success" size="small">Решено</el-tag>
            <el-button v-else-if="org.can('acc.doc.post')" size="small" @click="retry(row)" :loading="row._busy">{{ t('retry') }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { TRADE_TYPES, fmtDate, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const { t, lang } = useI18n()
const loading = ref(false)
const busy = ref(false)
const status = ref<any>(null)
const issues = ref<any[]>([])
const showResolved = ref(false)
const tl = (k?: string) => (k && TRADE_TYPES[k] ? TRADE_TYPES[k][lang.value] : k || '')

async function load() {
  loading.value = true
  try {
    status.value = await api.get('/accounting/autopilot/status')
    issues.value = (await api.get('/accounting/autopilot/issues', { params: { all: showResolved.value ? 'true' : undefined } })) as any
  } catch (e) { showError(e) }
  loading.value = false
}

async function retry(row: any) {
  row._busy = true
  try {
    const r = (await api.post(`/accounting/autopilot/documents/${row.sourceId}/retry`)) as any
    if (r.status === 'ERROR') showError({ message: r.message })
    else ElMessage.success('Документ отражён')
    await load()
  } catch (e) { showError(e) }
  row._busy = false
}

async function resync() {
  try {
    await ElMessageBox.confirm('Все документы организации будут заново проверены и при необходимости перепроведены в учёте. Неизменённые документы не затрагиваются. Продолжить?', t('resync'), { type: 'warning', confirmButtonText: 'Перепровести', cancelButtonText: 'Отмена' })
  } catch { return }
  busy.value = true
  try {
    const r = (await api.post('/accounting/autopilot/resync', {})) as any
    ElMessageBox.alert(`Всего: ${r.total}\nОтражено: ${r.posted}\nБез изменений: ${r.unchanged}\nСнято с учёта: ${r.cancelled}\nПропущено: ${r.skipped}\nОшибок: ${r.errors}`, 'Результат', { confirmButtonText: 'OK' })
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.hint { color: #909399; font-size: 12px; margin-top: 6px; }
.st-title { color: #909399; font-size: 12px; margin-bottom: 6px; }
.fix { color: #606266; font-size: 12px; margin-top: 4px; }
</style>
