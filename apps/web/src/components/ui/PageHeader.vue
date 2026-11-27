<template>
  <div class="ph">
    <div class="ph-main">
      <div v-if="iconName" class="ph-icon" :style="{ '--c': tone }"><el-icon :size="22"><component :is="iconName" /></el-icon></div>
      <div class="ph-text">
        <div class="ph-title">
          <h1>{{ title }}</h1>
          <slot name="badge" />
        </div>
        <div v-if="subtitle || $slots.subtitle" class="ph-sub"><slot name="subtitle">{{ subtitle }}</slot></div>
      </div>
    </div>
    <div v-if="$slots.default" class="ph-actions"><slot /></div>
  </div>
</template>

<script setup lang="ts">
/**
 * Заголовок страницы: иконка раздела (из меню по адресу страницы или явная), название, пояснение, кнопки справа.
 * Один вид на всех экранах.
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { findMenuIcon } from '@/components/layout/menu'

const props = defineProps<{ title: string; subtitle?: string; icon?: string }>()
const route = useRoute()
const found = computed(() => findMenuIcon(route.path))
const iconName = computed(() => props.icon ?? found.value?.icon ?? null)
const tone = computed(() => found.value?.tone ?? '#1769e0')
</script>

<style scoped>
.ph { display: flex; justify-content: space-between; align-items: center; gap: 12px 16px; flex-wrap: wrap; margin-bottom: 20px; }
.ph-main { display: flex; align-items: center; gap: 14px; min-width: 0; }
.ph-icon {
  width: 44px; height: 44px; border-radius: 12px; flex: none; display: flex; align-items: center; justify-content: center;
  color: var(--c); background: color-mix(in srgb, var(--c) 11%, transparent); border: 1px solid color-mix(in srgb, var(--c) 22%, transparent);
}
.ph-text { min-width: 0; }
.ph-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
h1 { font-size: 24px; font-weight: 700; color: var(--el-text-color-primary); line-height: 1.25; margin: 0; letter-spacing: -.02em; }
.ph-sub { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 3px; }
.ph-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ph-actions :deep(.el-button + .el-button) { margin-left: 0; }
@media (max-width: 640px) { h1 { font-size: 19px; } .ph-icon { width: 38px; height: 38px; } .ph-actions { width: 100%; } }
</style>
