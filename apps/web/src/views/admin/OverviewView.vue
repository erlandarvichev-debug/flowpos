<template>
  <div v-loading="loading">
    <template v-if="d">
      <div class="tiles">
        <div class="tile"><div class="n">{{ d.organizations }}</div><div class="l">организаций<span v-if="d.organizations !== d.organizationsActive"> · активных {{ d.organizationsActive }}</span></div></div>
        <div class="tile"><div class="n">{{ d.users }}</div><div class="l">пользователей</div></div>
        <div class="tile"><div class="n">{{ d.active7 }}</div><div class="l">входили за 7 дней<span> · за 30 — {{ d.active30 }}</span></div></div>
        <div class="tile"><div class="n">{{ d.field.reps }}</div><div class="l">торговых · телефонов {{ d.field.devices }}</div></div>
        <div class="tile"><div class="n">{{ d.ai.organizations }}</div><div class="l">компаний с Claude · подключений {{ d.ai.connections }}</div></div>
        <div class="tile"><div class="n">{{ d.signups7 }}</div><div class="l">регистраций за 7 дней</div></div>
      </div>

      <div class="grid">
        <el-card shadow="never">
          <template #header>Решения</template>
          <div v-for="s in d.solutions" :key="s.code" class="sol">
            <div class="sol-name">{{ s.name }}</div>
            <div class="sol-n"><b>{{ s.enabled }}</b> включено<span v-if="s.trial"> · пробных {{ s.trial }}</span><span v-if="s.suspended" class="muted"> · выключено {{ s.suspended }}</span></div>
          </div>
          <el-alert v-for="x in d.expiringSoon" :key="x.organizationId + x.solution" type="warning" :closable="false" class="soon" show-icon>
            <router-link :to="`/organizations/${x.organizationId}`">{{ x.organization }}</router-link> — «{{ x.name }}» до {{ fmtDay(x.validUntil) }}
          </el-alert>
        </el-card>

        <el-card shadow="never">
          <template #header>Торговые сегодня</template>
          <div class="kv"><span>Телефонов на связи за сутки</span><b>{{ d.field.seen24 }} из {{ d.field.devices }}</b></div>
          <div class="kv"><span>Посещений сегодня</span><b>{{ d.field.visitsToday }}</b></div>
          <div class="kv"><span>Посещений за 7 дней</span><b>{{ d.field.visits7 }}</b></div>
          <div class="kv"><span>Заказов с телефонов сегодня</span><b>{{ d.field.ordersToday }}</b></div>
        </el-card>

        <el-card shadow="never">
          <template #header>Последние входы</template>
          <div v-if="!d.recentLogins.length" class="muted">Пока никто не входил</div>
          <div v-for="u in d.recentLogins" :key="u.email" class="row">
            <div><div>{{ u.name || u.email }}</div><div class="muted">{{ u.email }} · {{ u.organization || '—' }}</div></div>
            <div class="muted nowrap" :title="fmtDateTime(u.at)">{{ ago(u.at) }}</div>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header><div class="hdr">Изменения подписок <router-link to="/journal">весь журнал</router-link></div></template>
          <div v-if="!d.recentEvents.length" class="muted">Изменений не было</div>
          <div v-for="(e, i) in d.recentEvents" :key="i" class="row">
            <div>
              <div><router-link :to="`/organizations/${e.organizationId}`">{{ e.organization }}</router-link> · {{ e.name }}</div>
              <div class="muted">{{ describeSub(e.after) }}<template v-if="e.userEmail"> · {{ e.userEmail }}</template></div>
            </div>
            <div class="muted nowrap" :title="fmtDateTime(e.ts)">{{ ago(e.ts) }}</div>
          </div>
        </el-card>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { ago, describeSub, fmtDateTime, fmtDay } from './admin'

const d = ref<any>(null)
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try { d.value = await api.get('/platform/overview') } catch (e) { showError(e) }
  loading.value = false
})
</script>

<style scoped>
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 16px; }
.tile { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px; }
.tile .n { font-size: 30px; font-weight: 700; color: #0f766e; line-height: 1.1; }
.tile .l { color: #6b7280; font-size: 13px; margin-top: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
.sol { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f1f5f9; }
.sol:last-of-type { border-bottom: 0; }
.sol-name { font-weight: 600; }
.soon { margin-top: 8px; }
.kv { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #f1f5f9; }
.kv:last-child { border-bottom: 0; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid #f1f5f9; }
.row:last-child { border-bottom: 0; }
.hdr { display: flex; justify-content: space-between; align-items: center; }
.hdr a, .row a, .soon a { color: #0f766e; }
.muted { color: #909399; font-size: 12px; }
.nowrap { white-space: nowrap; }
@media (max-width: 400px) { .grid { grid-template-columns: 1fr; } }
</style>
