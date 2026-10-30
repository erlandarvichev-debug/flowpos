<template>
  <!-- FP-024: карантин входящих ЭСФ — что не попало в реестр, почему и что с этим делать. Действия — с причиной (журнал). -->
  <el-card>
    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;"
      title="Сюда попадают входящие ЭСФ, которые FlowPOS не смог безопасно записать в реестр. Документ сохранён ровно в том виде, как его отдала ИС ЭСФ; в ИС ЭСФ он существует независимо от этого списка." />
    <div class="bar">
      <el-radio-group v-model="status" size="small" @change="load">
        <el-radio-button value="OPEN">Требуют разбора</el-radio-button>
        <el-radio-button value="RESOLVED">Разобраны</el-radio-button>
        <el-radio-button value="ALL">Все</el-radio-button>
      </el-radio-group>
    </div>
    <el-table v-loading="loading" :data="items" size="small" :empty-text="status === 'OPEN' ? 'Карантин пуст — все входящие ЭСФ в реестре' : 'Записей нет'">
      <el-table-column label="Получен" width="140"><template #default="{ row }">{{ dt(row.firstSeenAt) }}</template></el-table-column>
      <el-table-column label="ЭСФ в ИС ЭСФ" min-width="190">
        <template #default="{ row }">
          <div>{{ row.registrationNumber || '—' }}</div>
          <div class="muted">ID {{ row.esfId }}</div>
        </template>
      </el-table-column>
      <el-table-column label="Причина" min-width="260">
        <template #default="{ row }">
          <el-tag :type="CONFLICTS.includes(row.errorCode) ? 'danger' : 'warning'" size="small" effect="plain">{{ row.errorTitle }}</el-tag>
          <div class="muted detail">{{ row.errorDetail }}</div>
        </template>
      </el-table-column>
      <el-table-column label="Состояние" width="200">
        <template #default="{ row }">
          <span v-if="row.status === 'OPEN'">Ждёт разбора<span v-if="row.replayAttempts" class="muted"> · попыток {{ row.replayAttempts }}</span></span>
          <span v-else>{{ RESOLUTION[row.resolution] ?? row.resolution }} <span class="muted">{{ dt(row.resolvedAt) }}</span></span>
          <div v-if="row.seenCount > 1" class="muted">получен {{ row.seenCount }} раз</div>
        </template>
      </el-table-column>
      <el-table-column label="" width="110">
        <template #default="{ row }"><el-button link type="primary" @click="open(row.id)">{{ row.status === 'OPEN' ? 'Разобрать' : 'Открыть' }}</el-button></template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-drawer :model-value="!!card" size="min(900px, 100%)" :title="card ? `Входящий ЭСФ ${card.registrationNumber || card.esfId}` : ''" @close="card = null">
    <template v-if="card">
      <el-alert :type="CONFLICTS.includes(card.errorCode) ? 'error' : 'warning'" :closable="false" show-icon :title="card.errorTitle">
        <div>{{ card.errorDetail }}</div>
        <div v-if="card.errorAction" class="action"><b>Что делать:</b> {{ card.errorAction }}</div>
      </el-alert>
      <el-descriptions :column="2" border size="small" class="block">
        <el-descriptions-item label="ID в ИС ЭСФ">{{ card.esfId }}</el-descriptions-item>
        <el-descriptions-item label="Рег. номер">{{ card.registrationNumber || '—' }}</el-descriptions-item>
        <el-descriptions-item label="Статус в ИС ЭСФ (при получении)">{{ card.invoiceStatus || '—' }}</el-descriptions-item>
        <el-descriptions-item label="Среда">{{ card.environment === 'PROD' ? 'Боевая' : 'Тестовая' }}</el-descriptions-item>
        <el-descriptions-item label="Код причины">{{ card.errorCode }}</el-descriptions-item>
        <el-descriptions-item label="Получен">{{ dt(card.firstSeenAt) }}<span v-if="card.seenCount > 1"> · {{ card.seenCount }} раз, последний {{ dt(card.lastSeenAt) }}</span></el-descriptions-item>
        <el-descriptions-item label="SHA-256 тела" :span="2"><code>{{ card.bodyHash }}</code> · {{ card.bodyBytes }} байт
          <el-tag v-if="!card.bodyIntact" type="danger" size="small">тело неполное</el-tag></el-descriptions-item>
        <el-descriptions-item v-if="card.traceId" label="Код трассировки" :span="2"><code>{{ card.traceId }}</code></el-descriptions-item>
        <el-descriptions-item v-if="card.status === 'RESOLVED'" label="Решение" :span="2">
          {{ RESOLUTION[card.resolution] ?? card.resolution }} · {{ dt(card.resolvedAt) }}<div class="muted">Причина: {{ card.resolutionReason }}</div>
          <el-button v-if="card.resultInvoiceId" link type="primary" @click="emit('open-invoice', card.resultInvoiceId)">Открыть ЭСФ в реестре</el-button>
        </el-descriptions-item>
      </el-descriptions>

      <div v-if="card.status === 'OPEN' && canAct" class="block actions">
        <el-button v-if="card.replayable" type="primary" :disabled="!card.bodyIntact" :loading="busy" @click="replay">Обработать повторно</el-button>
        <el-button v-if="card.errorCode === 'ESF_IN_HASH_CONFLICT'" type="warning" :loading="busy" @click="resolve('ACCEPT_NEW')">Принять новую версию</el-button>
        <el-button v-if="CONFLICTS.includes(card.errorCode)" :loading="busy" @click="resolve('KEEP_EXISTING')">Оставить полученную ранее</el-button>
        <el-button type="danger" plain :loading="busy" @click="resolve('DISMISS')">Закрыть без импорта</el-button>
      </div>
      <div v-else-if="card.status === 'OPEN'" class="block muted">Разбирать карантин может сотрудник с правом отправки ЭСФ.</div>

      <el-row :gutter="12" class="block">
        <el-col :span="card.existing ? 12 : 24">
          <div class="cap">Получено сейчас{{ shown(card.body) }}</div>
          <pre class="xml">{{ card.body.slice(0, LIMIT) }}</pre>
        </el-col>
        <el-col v-if="card.existing" :span="12">
          <div class="cap">
            В реестре: № {{ card.existing.num }} от {{ fmtDate(card.existing.date) }}, {{ card.existing.sellerName || card.existing.sellerTin }}
            <el-button link type="primary" @click="emit('open-invoice', card.existing.id)">открыть</el-button>{{ shown(card.existing.body) }}
          </div>
          <pre class="xml">{{ card.existing.body.slice(0, LIMIT) }}</pre>
        </el-col>
      </el-row>

      <div class="cap block">История</div>
      <el-timeline>
        <el-timeline-item v-for="(h, i) in card.history" :key="i" :timestamp="dt(h.ts)">
          {{ HISTORY[h.action] ?? h.action }}<span v-if="h.reason" class="muted"> — {{ h.reason }}</span>
          <span v-if="h.after?.code && h.action === 'ESF_QUARANTINE_REPLAY_FAILED'" class="muted"> ({{ h.after.code }})</span>
        </el-timeline-item>
      </el-timeline>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { fmtDate, showError } from '../acc'

defineProps<{ canAct: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'open-invoice', id: string): void }>()

const CONFLICTS = ['ESF_IN_HASH_CONFLICT', 'ESF_IN_KEY_CONFLICT']
const LIMIT = 200_000
const RESOLUTION: Record<string, string> = { REPLAYED: 'Обработан повторно', ACCEPTED_NEW: 'Принята новая версия', KEPT_EXISTING: 'Оставлена прежняя версия', DISMISSED: 'Закрыт без импорта' }
const HISTORY: Record<string, string> = {
  ESF_QUARANTINE_ADDED: 'Помещён в карантин', ESF_QUARANTINE_REPLAYED: 'Обработан повторно — в реестре', ESF_QUARANTINE_REPLAY_FAILED: 'Повторная обработка не удалась',
  ESF_QUARANTINE_RESOLVED: 'Закрыт решением', ESF_QUARANTINE_ACCEPTED_NEW: 'Принята новая версия',
}
const PROMPT: Record<string, { title: string; text: string; ok: string }> = {
  REPLAY: { title: 'Обработать повторно', text: 'Документ будет проверен заново текущими правилами FlowPOS. Что исправлено?', ok: 'Обработать' },
  ACCEPT_NEW: { title: 'Принять новую версию', text: 'Документ в реестре будет заменён полученным сейчас (прежний сохранится в карантине). Подтвердите основание — например, сверку с порталом ИС ЭСФ.', ok: 'Принять' },
  KEEP_EXISTING: { title: 'Оставить полученную ранее', text: 'Реестр не меняется, запись закрывается. Укажите основание.', ok: 'Оставить' },
  DISMISS: { title: 'Закрыть без импорта', text: 'Документ не попадёт в реестр FlowPOS (в ИС ЭСФ он остаётся). Укажите причину.', ok: 'Закрыть' },
}

const status = ref<'OPEN' | 'RESOLVED' | 'ALL'>('OPEN')
const items = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const card = ref<any>(null)

const dt = (v?: string | null) => (v ? new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '')
const shown = (b: string) => (b.length > LIMIT ? ` (показано ${LIMIT.toLocaleString('ru-RU')} из ${b.length.toLocaleString('ru-RU')} символов)` : '')

async function load() {
  loading.value = true
  try {
    items.value = ((await api.get('/accounting/esf/quarantine', { params: { status: status.value } })) as any).items
  } catch (e) { showError(e) }
  loading.value = false
}

async function open(id: string) {
  try { card.value = await api.get(`/accounting/esf/quarantine/${id}`) } catch (e) { showError(e) }
}

async function askReason(kind: string): Promise<string | null> {
  const p = PROMPT[kind]
  try {
    const { value } = await ElMessageBox.prompt(p.text, p.title, {
      confirmButtonText: p.ok, cancelButtonText: 'Отмена', inputType: 'textarea',
      inputValidator: (v: string) => (String(v ?? '').trim().length >= 10 ? true : 'Не короче 10 символов'),
    })
    return String(value).trim()
  } catch { return null }
}

async function after(id: string) {
  await Promise.all([load(), open(id)])
  emit('changed')
}

async function replay() {
  const id = card.value.id
  const reason = await askReason('REPLAY')
  if (!reason) return
  busy.value = true
  try {
    const r: any = await api.post(`/accounting/esf/quarantine/${id}/replay`, { reason })
    if (r.outcome === 'STILL_QUARANTINED') ElMessage.warning(`Документ по-прежнему не проходит проверку: ${r.title}`)
    else ElMessage.success(r.outcome === 'IMPORTED' ? 'Документ записан в реестр' : 'Документ уже был в реестре — запись закрыта')
    await after(id)
  } catch (e) { showError(e) }
  busy.value = false
}

async function resolve(action: 'ACCEPT_NEW' | 'KEEP_EXISTING' | 'DISMISS') {
  const id = card.value.id
  const reason = await askReason(action)
  if (!reason) return
  busy.value = true
  try {
    await api.post(`/accounting/esf/quarantine/${id}/resolve`, { action, reason })
    ElMessage.success(RESOLUTION[action === 'ACCEPT_NEW' ? 'ACCEPTED_NEW' : action === 'KEEP_EXISTING' ? 'KEPT_EXISTING' : 'DISMISSED'])
    await after(id)
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(load)
</script>

<style scoped>
.bar { margin-bottom: 10px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.detail { word-break: break-word; }
.block { margin-top: 12px; }
.action { margin-top: 6px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cap { font-weight: 600; margin-bottom: 6px; }
.xml { max-height: 360px; overflow: auto; background: var(--el-fill-color-light); padding: 8px; font-size: 12px; white-space: pre-wrap; word-break: break-all; margin: 0; }
</style>
