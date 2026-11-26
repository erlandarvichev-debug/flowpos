<template>
  <!-- Страница раздела меню: плитки его подразделов (тот же список, что в боковом меню, — components/layout/menu.ts). -->
  <div>
    <template v-if="section">
      <div class="head">
        <div class="head-icon" :style="{ '--c': SECTION_TONES[section.key] ?? '#1769e0' }"><el-icon :size="26"><component :is="section.icon" /></el-icon></div>
        <div>
          <h1>{{ section.title }}</h1>
          <p class="desc">{{ section.desc }}</p>
        </div>
      </div>
      <div class="tiles">
        <router-link v-for="(it, i) in section.items" :key="it.path" :to="it.path" class="tile" :style="{ '--d': `${i * 40}ms`, '--c': SECTION_TONES[section.key] ?? '#1769e0' }">
          <div class="t-icon"><el-icon :size="22"><component :is="it.icon" /></el-icon></div>
          <div class="t-body">
            <div class="t-title">
              {{ it.title }}
              <el-badge v-if="it.badge === 'autopilot' && autopilotIssues" :value="autopilotIssues" type="danger" class="t-badge" />
            </div>
            <div class="t-desc">{{ it.desc }}</div>
          </div>
          <el-icon class="t-arrow"><ArrowRight /></el-icon>
        </router-link>
      </div>
    </template>
    <el-empty v-else-if="loaded" description="Раздел недоступен для вашей роли или не подключён у организации">
      <router-link to="/dashboard"><el-button type="primary">На главную</el-button></router-link>
    </el-empty>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useSolutionsStore } from '@/stores/solutions'
import { SECTION_TONES, buildMenu } from '@/components/layout/menu'

const route = useRoute()
const org = useOrgStore()
const solutions = useSolutionsStore()
const autopilotIssues = ref(0)
const notSupervisor = computed(() => org.context?.role !== 'supervisor')
const menu = computed(() => buildMenu({
  showTrade: solutions.trade && notSupervisor.value,
  showAcc: solutions.accounting && notSupervisor.value,
  supervisor: solutions.supervisor,
  can: (p) => org.can(p),
}))
const section = computed(() => menu.value.find((s) => s.key === route.params.key))
const loaded = computed(() => solutions.loaded && !!org.context)

onMounted(async () => {
  if (route.params.key === 'operations') {
    try { autopilotIssues.value = ((await api.get('/accounting/autopilot/status')) as any).openIssues || 0 } catch { autopilotIssues.value = 0 }
  }
})
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 16px; margin-bottom: 22px; }
.head-icon { width: 56px; height: 56px; border-radius: 14px; background: var(--c); color: #fff; display: flex; align-items: center; justify-content: center; flex: none; box-shadow: 0 8px 20px color-mix(in srgb, var(--c) 30%, transparent); }
h1 { margin: 0; font-size: 24px; color: var(--fp-text); letter-spacing: -.02em; }
.desc { margin: 4px 0 0; color: var(--fp-text-2); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.tile {
  display: flex; align-items: center; gap: 14px; padding: 18px 16px; background: var(--fp-surface); border: 1px solid var(--fp-border); border-radius: 12px;
  text-decoration: none; color: inherit; transition: transform .18s, box-shadow .18s, border-color .18s;
  animation: tile-in .35s ease both; animation-delay: var(--d);
}
.tile:hover { transform: translateY(-3px); box-shadow: 0 10px 24px rgba(15, 23, 42, .08); border-color: color-mix(in srgb, var(--c) 40%, transparent); }
.tile:hover .t-arrow { transform: translateX(3px); color: var(--c); }
.t-icon { width: 44px; height: 44px; border-radius: 10px; background: color-mix(in srgb, var(--c) 11%, transparent); color: var(--c); display: flex; align-items: center; justify-content: center; flex: none; }
.t-body { flex: 1; min-width: 0; }
.t-title { font-weight: 600; color: var(--fp-text); display: flex; align-items: center; gap: 6px; }
.t-desc { color: var(--fp-text-2); font-size: 13px; margin-top: 3px; line-height: 1.4; }
.t-arrow { color: #c0c4cc; transition: transform .18s, color .18s; flex: none; }
.t-badge :deep(.el-badge__content) { position: static; transform: none; }
@keyframes tile-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .tile { animation: none; transition: none; } }
@media (max-width: 600px) { .tiles { grid-template-columns: 1fr; } .head h1 { font-size: 20px; } }
</style>
