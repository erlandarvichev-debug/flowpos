<template>
  <!-- Иконка раздела в шапке страницы (по адресу страницы — из меню), в цвете раздела. Один вид с PageHeader. -->
  <span v-if="found" class="page-ic" :style="{ '--c': found.tone }"><el-icon :size="22"><component :is="found.icon" /></el-icon></span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { findMenuIcon } from '@/components/layout/menu'

const route = useRoute()
const found = computed(() => findMenuIcon(route.path))
</script>
