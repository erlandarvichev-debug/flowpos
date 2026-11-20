<template>
  <!-- Все пользователи всех клиентов. -->
  <el-card shadow="never">
    <div class="filters">
      <el-input v-model="q" clearable placeholder="Email или имя" class="search" @change="load" />
      <el-checkbox v-model="onlyRecent">входили за 30 дней</el-checkbox>
      <span class="muted">Показано: {{ shown.length }} из {{ users.length }}</span>
    </div>
    <el-table :data="shown" v-loading="loading" size="small" empty-text="Пользователей нет">
      <el-table-column label="Пользователь" min-width="230">
        <template #default="{ row }">
          {{ row.name || '—' }}
          <el-tag v-if="row.isPlatformAdmin" size="small" class="ml">администратор платформы</el-tag>
          <div class="muted">{{ row.email }}<template v-if="row.phone"> · {{ row.phone }}</template></div>
        </template>
      </el-table-column>
      <el-table-column label="Организации и роли" min-width="240">
        <template #default="{ row }">
          <div v-if="!row.memberships.length" class="muted">{{ row.organization?.name || '—' }}</div>
          <div v-for="m in row.memberships" :key="m.organizationId">
            <router-link :to="`/organizations/${m.organizationId}`" class="link">{{ m.organization }}</router-link>
            <span class="muted"> · {{ ROLES[m.role] || m.role }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="Последний вход" min-width="140"><template #default="{ row }"><span :title="fmtDateTime(row.lastLoginAt)">{{ ago(row.lastLoginAt) }}</span></template></el-table-column>
      <el-table-column label="2FA" width="70"><template #default="{ row }"><el-tag v-if="row.mfa" size="small" type="success">да</el-tag><span v-else class="muted">нет</span></template></el-table-column>
      <el-table-column label="Заведён" width="110"><template #default="{ row }">{{ fmtDay(row.createdAt) }}</template></el-table-column>
      <el-table-column label="" width="100"><template #default="{ row }"><el-tag v-if="!row.isActive" size="small" type="info">отключён</el-tag></template></el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { ROLES, ago, fmtDateTime, fmtDay } from './admin'

const users = ref<any[]>([])
const q = ref('')
const onlyRecent = ref(false)
const loading = ref(false)
const shown = computed(() => {
  if (!onlyRecent.value) return users.value
  const from = Date.now() - 30 * 86400 * 1000
  return users.value.filter((u) => u.lastLoginAt && new Date(u.lastLoginAt).getTime() >= from)
})

async function load() {
  loading.value = true
  try { users.value = (await api.get('/platform/users', { params: { q: q.value || undefined } })) as any } catch (e) { showError(e) }
  loading.value = false
}
onMounted(load)
</script>

<style scoped>
.filters { display: flex; gap: 14px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.search { width: 280px; max-width: 100%; }
.muted { color: #909399; font-size: 12px; }
.ml { margin-left: 6px; }
.link { color: #0f766e; text-decoration: none; }
</style>
