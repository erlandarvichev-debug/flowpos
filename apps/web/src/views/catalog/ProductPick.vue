<template>
  <!-- FP-027: выбор товара с поиском на сервере (название, код, артикул, штрихкод); имена — в общий справочник экрана. -->
  <el-select :model-value="modelValue" :multiple="multiple" filterable remote clearable :remote-method="search" :loading="loading"
    :placeholder="placeholder ?? 'Товар: название или штрихкод'" :style="{ width: multiple ? '100%' : '360px' }" @update:model-value="(v: any) => emit('update:modelValue', v)">
    <el-option v-for="o in options" :key="o.id" :label="o.name" :value="o.id" />
  </el-select>
</template>

<script setup lang="ts">
import { ref, inject, computed } from 'vue'
import api from '@/api/client'

const props = defineProps<{ modelValue: any; multiple?: boolean; placeholder?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: any): void }>()
const names = inject<Record<string, string>>('pricingProductNames', {})
const found = ref<{ id: string; name: string }[]>([])
const loading = ref(false)
/** Выбранные — всегда в списке (иначе select показал бы id). */
const options = computed(() => {
  const sel = (props.multiple ? props.modelValue ?? [] : props.modelValue ? [props.modelValue] : []) as string[]
  const extra = sel.filter((id) => !found.value.some((f) => f.id === id)).map((id) => ({ id, name: names[id] ?? id.slice(0, 8) }))
  return [...extra, ...found.value]
})

async function search(q: string) {
  if (!q || q.length < 2) return
  loading.value = true
  try {
    const r: any = await api.get('/catalog/items', { params: { search: q, limit: 20 } })
    found.value = r.items.map((i: any) => ({ id: i.id, name: i.name }))
    for (const i of found.value) names[i.id] = i.name
  } catch { found.value = [] }
  loading.value = false
}
</script>
