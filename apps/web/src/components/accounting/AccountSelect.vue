<template>
  <el-select
    :model-value="modelValue"
    @update:model-value="(v: any) => emit('update:modelValue', v)"
    filterable :filter-method="filter" placeholder="Счёт" size="small" style="width: 100%;"
    @visible-change="(o: boolean) => o && (query = '')"
  >
    <el-option v-for="a in filtered" :key="a.code" :value="a.code" :disabled="a.isGroup" :label="`${a.code} ${nm(a)}`">
      <span style="font-weight: 600; margin-right: 8px;">{{ a.code }}</span>
      <span style="color: #606266;">{{ nm(a) }}</span>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from '@/composables/useI18n'

const props = defineProps<{ modelValue?: string; accounts: any[] }>()
const emit = defineEmits(['update:modelValue'])
const { nm } = useI18n()
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = props.accounts.filter((a) => !a.isGroup)
  if (!q) return list
  return list.filter((a) => a.code.startsWith(q) || a.name.toLowerCase().includes(q) || (a.nameKk || '').toLowerCase().includes(q))
})

function filter(q: string) { query.value = q }
</script>
