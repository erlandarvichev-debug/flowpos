<template>
  <!-- FP-020: итог массового действия — сколько, общий эффект и ошибки по каждой строке; частичный успех не прячется. -->
  <el-dialog :model-value="open" :title="title" width="720px" @update:model-value="(v: boolean) => !v && emit('close')">
    <el-alert
      :type="failed ? (succeeded ? 'warning' : 'error') : 'success'"
      :closable="false"
      show-icon
      :title="failed ? (succeeded ? `Выполнено частично: ${succeeded} из ${rows.length}` : `Не выполнено: ${failed} из ${rows.length}`) : `Выполнено: ${succeeded} из ${rows.length}`"
      style="margin-bottom: 12px;"
    >
      <template v-if="effect" #default>{{ effect }}</template>
    </el-alert>
    <el-table :data="rows" size="small" max-height="420" aria-label="Результат по каждому ЭСФ">
      <el-table-column label="№" width="170" prop="label" />
      <el-table-column label="Итог" width="170">
        <template #default="{ row }"><el-tag size="small" :type="kind(row)[1]">{{ kind(row)[0] }}</el-tag></template>
      </el-table-column>
      <el-table-column label="Подробности" min-width="260"><template #default="{ row }">{{ row.message || '—' }}</template></el-table-column>
    </el-table>
    <template #footer><el-button type="primary" @click="emit('close')">Закрыть</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export interface BulkRow { label: string; outcome: 'OK' | 'FAILED' | 'UNKNOWN'; message?: string }
const props = defineProps<{ open: boolean; title: string; rows: BulkRow[]; effect?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const KIND: Record<BulkRow['outcome'], [string, 'success' | 'danger' | 'warning']> = {
  OK: ['Выполнено', 'success'],
  FAILED: ['Не выполнено', 'danger'],
  UNKNOWN: ['Результат неизвестен', 'warning'],
}
const kind = (r: BulkRow) => KIND[r.outcome]
const succeeded = computed(() => props.rows.filter((r) => r.outcome === 'OK').length)
const failed = computed(() => props.rows.length - succeeded.value)
</script>
