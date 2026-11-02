<template>
  <!-- Изолированная рамка печатной формы: без скриптов, без внешних загрузок (CSP в документе). -->
  <iframe ref="frame" class="print-frame" sandbox="allow-same-origin allow-modals" :srcdoc="doc" title="Печатная форма" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { render, frameDocument } from '@print-engine'

const props = defineProps<{ html: string; data: Record<string, unknown> | null }>()
const emit = defineEmits<{ (e: 'error', message: string): void }>()
const frame = ref<HTMLIFrameElement | null>(null)

const doc = computed(() => {
  if (!props.data) return frameDocument('<p style="color:#888">Нет данных для предпросмотра</p>')
  try { return frameDocument(render(props.html, props.data)) } catch (e: any) {
    emit('error', e?.message ?? String(e))
    return frameDocument(`<p style="color:#c62828">Ошибка шаблона: ${String(e?.message ?? e).replace(/</g, '&lt;')}</p>`)
  }
})

function print() { frame.value?.contentWindow?.print() }
defineExpose({ print })
</script>

<style scoped>
.print-frame { width: 100%; height: 100%; min-height: 600px; border: 1px solid var(--el-border-color); background: #fff; border-radius: 4px; }
</style>
