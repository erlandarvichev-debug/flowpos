<template>
  <!-- Все организации всех клиентов и их подписки на решения. -->
  <el-card shadow="never">
    <div class="filters">
      <el-input v-model="q" clearable placeholder="Название или БИН" class="search" @change="load" />
      <span class="muted">Организаций: {{ orgs.length }}. «Учётная система» и «Бухгалтерия» у организации без подписки включены; «Супервайзер» — только после подключения.</span>
    </div>
    <el-table :data="orgs" v-loading="loading" size="small" empty-text="Организаций нет" @row-click="(r: any) => router.push(`/organizations/${r.id}`)" row-class-name="clickable">
      <el-table-column label="Организация" min-width="220">
        <template #default="{ row }">
          <router-link :to="`/organizations/${row.id}`" class="name" @click.stop>{{ row.name }}</router-link>
          <el-tag v-if="!row.isActive" size="small" type="info" class="ml">не активна</el-tag>
          <div class="muted">{{ row.inn || 'без БИН' }} · создана {{ fmtDay(row.createdAt) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="Владелец" min-width="190">
        <template #default="{ row }"><div v-for="o in row.owners" :key="o.email">{{ o.name }}<div class="muted">{{ o.email }}</div></div></template>
      </el-table-column>
      <el-table-column label="Польз." width="70" align="right" prop="members" />
      <el-table-column v-for="s in solutions" :key="s.code" :label="s.name" min-width="210">
        <template #default="{ row }">
          <div class="sub">
            <el-tag :type="solutionTag(row.solutions[s.code])" size="small">{{ solutionLabel(row.solutions[s.code], s.onByDefault) }}</el-tag>
            <el-button link type="primary" size="small" @click.stop="openEdit(row, s)">изменить</el-button>
          </div>
          <div class="muted">
            <template v-if="row.solutions[s.code].validUntil">до {{ fmtDay(row.solutions[s.code].validUntil) }}</template>
            <template v-if="s.code === 'supervisor' && row.solutions[s.code].status !== 'none'"> · торговых {{ row.reps }}<template v-if="row.solutions[s.code].seats != null"> из {{ row.solutions[s.code].seats }}</template></template>
            <template v-if="row.solutions[s.code].reason && row.solutions[s.code].status !== 'none'"> · {{ row.solutions[s.code].reason }}</template>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <SubscriptionDialog v-if="edit" v-model="editOpen" :org-id="edit.org.id" :org-name="edit.org.name" :solution="edit.s.code" :solution-name="edit.s.name"
      :on-by-default="edit.s.onByDefault" :state="edit.org.solutions[edit.s.code]" :note="edit.org.notes?.[edit.s.code]" @saved="load" />
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { fmtDay, solutionLabel, solutionTag } from './admin'
import SubscriptionDialog from './SubscriptionDialog.vue'

const router = useRouter()
const solutions = ref<{ code: string; name: string; onByDefault: boolean }[]>([])
const orgs = ref<any[]>([])
const q = ref('')
const loading = ref(false)
const edit = ref<any>(null)
const editOpen = ref(false)

async function load() {
  loading.value = true
  try { orgs.value = (await api.get('/platform/organizations', { params: { q: q.value || undefined } })) as any } catch (e) { showError(e) }
  loading.value = false
}

function openEdit(org: any, s: any) { edit.value = { org, s }; editOpen.value = true }

onMounted(async () => {
  try { solutions.value = (await api.get('/platform/solutions')) as any } catch (e) { showError(e) }
  await load()
})
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.search { width: 280px; max-width: 100%; }
.muted { color: #909399; font-size: 12px; }
.name { color: #0f766e; font-weight: 600; text-decoration: none; }
.ml { margin-left: 6px; }
.sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sub :deep(.el-button) { white-space: nowrap; }
:deep(.clickable) { cursor: pointer; }
</style>
