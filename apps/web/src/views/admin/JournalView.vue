<template>
  <!-- Журнал платформы: изменения подписок и администраторов платформы. Администраторы — внизу. -->
  <div>
    <el-card shadow="never">
      <template #header>Действия на платформе</template>
      <el-table :data="rows" v-loading="loading" size="small" empty-text="Записей нет">
        <el-table-column label="Когда" width="140"><template #default="{ row }">{{ fmtDateTime(row.ts) }}</template></el-table-column>
        <el-table-column label="Действие" min-width="200"><template #default="{ row }">{{ ACTIONS[row.action] || row.action }}</template></el-table-column>
        <el-table-column label="Организация" min-width="180">
          <template #default="{ row }">
            <router-link v-if="row.organizationId && row.action === 'SUBSCRIPTION_SET'" :to="`/organizations/${row.organizationId}`" class="link">{{ row.organization || '—' }}</router-link>
            <span v-else>{{ row.organization || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Что" min-width="260">
          <template #default="{ row }">
            <template v-if="row.action === 'SUBSCRIPTION_SET'">{{ describeSub(row.before) }} → {{ describeSub(row.after) }}</template>
            <template v-else>{{ row.after?.email || '' }}</template>
          </template>
        </el-table-column>
        <el-table-column label="Кто" min-width="170"><template #default="{ row }">{{ row.userEmail || 'скрипт на сервере' }}</template></el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>Администраторы платформы</template>
      <el-table :data="admins" size="small" empty-text="Нет">
        <el-table-column label="Пользователь" min-width="220"><template #default="{ row }">{{ row.name || '—' }}<div class="muted">{{ row.email }}</div></template></el-table-column>
        <el-table-column label="С" width="110"><template #default="{ row }">{{ fmtDay(row.since) }}</template></el-table-column>
        <el-table-column label="Последний вход" min-width="140"><template #default="{ row }">{{ ago(row.lastLoginAt) }}</template></el-table-column>
        <el-table-column label="2FA" width="80"><template #default="{ row }"><el-tag v-if="row.mfa" size="small" type="success">да</el-tag><el-tag v-else size="small" type="warning">нет</el-tag></template></el-table-column>
      </el-table>
      <p class="muted hint">Назначить или снять администратора — только на сервере: <code>deploy/scripts/platform-admin.mjs</code>.</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { ACTIONS, ago, describeSub, fmtDateTime, fmtDay } from './admin'

const rows = ref<any[]>([])
const admins = ref<any[]>([])
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    const [j, a] = await Promise.all([api.get('/platform/journal'), api.get('/platform/admins')])
    rows.value = j as any
    admins.value = a as any
  } catch (e) { showError(e) }
  loading.value = false
})
</script>

<style scoped>
.block { margin-top: 14px; }
.muted { color: #909399; font-size: 12px; }
.link { color: #0f766e; text-decoration: none; }
.hint { margin: 10px 0 0; }
</style>
