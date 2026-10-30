<template>
  <!-- FP-022: открытые оповещения обмена с ИС ЭСФ (кто действует и где инструкция) и, по запросу, метрики. -->
  <div v-if="health">
    <el-alert v-for="a in health.alerts" :key="a.id" :type="a.severity === 'CRITICAL' ? 'error' : 'warning'" :closable="false" show-icon class="alert" :title="a.message">
      <div>Ответственный: {{ a.owner }}</div>
      <div class="muted">Инструкция: {{ a.runbook }} · открыто {{ fmtDateTime(a.openedAt) }}</div>
    </el-alert>
    <el-card v-if="detailed" shadow="never" class="card">
      <template #header>Состояние обмена с ИС ЭСФ</template>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="Сессия ИС ЭСФ">{{ m.sessionOpen ? 'открыта' : 'нет входа' }}</el-descriptions-item>
        <el-descriptions-item label="Последняя успешная синхронизация">{{ m.syncOkAgeSec == null ? 'не было' : `${age(m.syncOkAgeSec)} назад` }}</el-descriptions-item>
        <el-descriptions-item label="Сбоев синхронизации подряд">
          {{ m.syncFailures }}<div v-if="m.syncFailures && m.lastSyncError" class="muted">{{ m.lastSyncError }}</div>
        </el-descriptions-item>
        <el-descriptions-item label="Курсор входящих">{{ m.cursorLagSec == null ? '—' : `${age(m.cursorLagSec)} назад` }}</el-descriptions-item>
        <el-descriptions-item label="Результат неизвестен (на сверке)">{{ m.unknownCount }}<span v-if="m.unknownOldestAgeSec != null" class="muted"> · старейший {{ age(m.unknownOldestAgeSec) }}</span></el-descriptions-item>
        <el-descriptions-item label="Отправка зависла">{{ m.sendingStuck }}</el-descriptions-item>
        <el-descriptions-item label="Входящие не разобраны (карантин)">{{ m.quarantineCount }}</el-descriptions-item>
        <el-descriptions-item label="Отклонено за сутки">{{ m.rejected24h }}</el-descriptions-item>
        <el-descriptions-item label="Отказов проверки подписи за сутки">{{ m.signingFailures24h }}</el-descriptions-item>
        <el-descriptions-item label="Просроченных решений">{{ m.decisionsOverdue }}</el-descriptions-item>
        <el-descriptions-item label="Фоновая обработка (этот сервер)">{{ health.workerLastTickAt ? fmtDateTime(health.workerLastTickAt) : 'не запускалась' }}</el-descriptions-item>
        <el-descriptions-item label="Открытых оповещений">{{ health.alerts.length }}</el-descriptions-item>
      </el-descriptions>
      <div class="muted note">Метрики показывают техническое состояние обмена; юридический статус документа — статус ИС ЭСФ в карточке ЭСФ.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ health: any; detailed?: boolean }>()
const m = computed(() => props.health?.metrics ?? {})

function age(sec: number) {
  if (sec >= 2 * 86400) return `${Math.floor(sec / 86400)} дн.`
  if (sec >= 2 * 3600) return `${Math.floor(sec / 3600)} ч`
  return `${Math.max(1, Math.floor(sec / 60))} мин`
}
const fmtDateTime = (v: string) => new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
</script>

<style scoped>
.alert { margin-bottom: 8px; }
.card { margin-bottom: 12px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.note { margin-top: 8px; }
</style>
