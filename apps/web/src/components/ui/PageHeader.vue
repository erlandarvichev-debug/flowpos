<template>
  <div class="ph">
    <div class="ph-main">
      <div class="ph-title">
        <h1>{{ title }}</h1>
        <slot name="badge" />
      </div>
      <div v-if="subtitle || $slots.subtitle" class="ph-sub"><slot name="subtitle">{{ subtitle }}</slot></div>
    </div>
    <div v-if="$slots.default" class="ph-actions"><slot /></div>
  </div>
</template>

<script setup lang="ts">
/** Заголовок страницы: название, пояснение одной строкой, кнопки действий справа. Один вид на всех экранах. */
defineProps<{ title: string; subtitle?: string }>()
</script>

<style scoped>
.ph { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px 16px; flex-wrap: wrap; margin-bottom: 16px; }
.ph-main { min-width: 0; }
.ph-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
h1 { font-size: 22px; font-weight: 600; color: var(--el-text-color-primary); line-height: 1.3; margin: 0; }
.ph-sub { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 4px; }
.ph-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
@media (max-width: 640px) { h1 { font-size: 19px; } .ph-actions { width: 100%; } }
</style>
