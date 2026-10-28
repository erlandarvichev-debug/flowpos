<template>
  <el-select
    :model-value="modelValue"
    @update:model-value="(v: any) => emit('update:modelValue', v || undefined)"
    filterable clearable remote :remote-method="search" :loading="loading"
    :placeholder="label" :size="size || 'small'" style="width: 100%;" @visible-change="onOpen"
  >
    <el-option v-for="o in options" :key="o.value" :label="o.label" :value="o.value" />
  </el-select>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { loadDimOptions, DIM_LABELS } from '@/views/accounting/acc'
import api from '@/api/client'

const props = defineProps<{ dim: string; modelValue?: string; selectedLabel?: string | null; size?: 'small' | 'default' | 'large' }>()
const emit = defineEmits(['update:modelValue'])
const options = ref<{ value: string; label: string }[]>([])
const loading = ref(false)
const label = DIM_LABELS[props.dim] || props.dim
const remoteDims = ['COUNTERPARTY', 'PRODUCT', 'EMPLOYEE']

async function search(q: string) {
  loading.value = true
  try {
    const list = await loadDimOptions(props.dim, remoteDims.includes(props.dim) ? q : '')
    options.value = remoteDims.includes(props.dim) || !q ? list : list.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))
  } catch { options.value = [] }
  loading.value = false
}

function onOpen(open: boolean) { if (open && !options.value.length) search('') }

/** Выбранное значение всегда показывается названием, даже если его нет в первой странице поиска. */
const LOOKUP: Record<string, (id: string) => Promise<string | null>> = {
  COUNTERPARTY: async (id) => ((await api.get(`/catalog/counterparties/${id}`)) as any)?.name ?? null,
  PRODUCT: async (id) => ((await api.get(`/catalog/items/${id}`)) as any)?.name ?? null,
  EMPLOYEE: async (id) => { const e = (await api.get(`/hr/employees/${id}`)) as any; return e ? `${e.lastName} ${e.firstName}` : null },
}

async function ensureSelected() {
  const v = props.modelValue
  if (!v || options.value.some((o) => o.value === v)) return
  let label = props.selectedLabel ?? null
  if (!label && LOOKUP[props.dim]) { try { label = await LOOKUP[props.dim](v) } catch { label = null } }
  if (label && props.modelValue === v) options.value = [{ value: v, label }, ...options.value]
}

onMounted(async () => {
  if (props.modelValue) await search('')
  await ensureSelected()
})
watch(() => [props.modelValue, props.selectedLabel], async () => {
  if (props.modelValue && !options.value.some((o) => o.value === props.modelValue)) {
    if (!props.selectedLabel && !options.value.length) await search('')
    await ensureSelected()
  }
})
</script>
