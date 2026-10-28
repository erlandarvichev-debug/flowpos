<template>
  <el-tooltip :content="tooltip" placement="top" :disabled="!status">
    <el-tag :type="tagType" size="small" style="cursor: default;">
      {{ label }}
    </el-tag>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status?: string }>()

const MAP: Record<string, { type: '' | 'success' | 'warning' | 'danger' | 'info'; label: string; tip: string }> = {
  SYNCED:   { type: 'success', label: '1С ✓',     tip: 'Синхронизировано с 1С' },
  DIRTY:    { type: 'warning', label: 'Не синх.',  tip: 'Ожидает отправки в 1С' },
  PENDING:  { type: 'warning', label: 'В очереди', tip: 'В очереди на синхронизацию' },
  CONFLICT: { type: 'danger',  label: 'Конфликт',  tip: 'Конфликт с данными 1С — требует разрешения' },
  ERROR:    { type: 'danger',  label: 'Ошибка',    tip: 'Ошибка синхронизации' },
}

const entry = computed(() => props.status ? MAP[props.status] : null)
const tagType = computed(() => entry.value?.type ?? 'info')
const label   = computed(() => entry.value?.label ?? props.status ?? '—')
const tooltip = computed(() => entry.value?.tip ?? '')
</script>
