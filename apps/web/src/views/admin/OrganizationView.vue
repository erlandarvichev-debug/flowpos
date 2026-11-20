<template>
  <!-- Карточка организации: реквизиты, подписки, пользователи, торговые и их телефоны, история подписок. -->
  <div v-loading="loading">
    <router-link to="/organizations" class="back">← все организации</router-link>
    <template v-if="o">
      <div class="head">
        <h2>{{ o.name }}</h2>
        <el-tag v-if="!o.isActive" type="info">не активна</el-tag>
      </div>
      <div class="muted line">
        {{ o.inn ? `БИН ${o.inn}` : 'без БИН' }} · создана {{ fmtDay(o.createdAt) }}
        <template v-if="o.client"> · клиент «{{ o.client }}»</template>
        <template v-if="o.phone"> · {{ o.phone }}</template>
        <template v-if="o.email"> · {{ o.email }}</template>
        · подключений МойСклад: {{ o.moyskladConnections }}
        <template v-if="o.selfSignupAt"> · зарегистрировалась на сайте {{ fmtDay(o.selfSignupAt) }}</template>
      </div>
      <div v-if="o.address" class="muted line">{{ o.address }}</div>

      <div class="subs">
        <div v-for="s in solutions" :key="s.code" class="subcard">
          <div class="sub-name">{{ s.name }}</div>
          <el-tag :type="solutionTag(o.solutions[s.code])">{{ solutionLabel(o.solutions[s.code], s.onByDefault) }}</el-tag>
          <div class="muted">
            {{ o.solutions[s.code].validUntil ? `до ${fmtDay(o.solutions[s.code].validUntil)}` : (o.solutions[s.code].status === 'none' ? '' : 'без срока') }}
            <template v-if="s.code === 'supervisor' && o.solutions[s.code].status !== 'none'"> · торговых {{ activeReps }}{{ o.solutions[s.code].seats != null ? ` из ${o.solutions[s.code].seats}` : '' }}</template>
          </div>
          <div v-if="o.notes?.[s.code]" class="muted note">{{ o.notes[s.code] }}</div>
          <el-button size="small" class="mt" @click="openEdit(s)">Изменить</el-button>
        </div>
      </div>

      <el-card shadow="never" class="block">
        <template #header>Пользователи ({{ o.members.length }})</template>
        <el-table :data="o.members" size="small" empty-text="Нет пользователей">
          <el-table-column label="Пользователь" min-width="220"><template #default="{ row }">{{ row.name || '—' }}<div class="muted">{{ row.email }}</div></template></el-table-column>
          <el-table-column label="Роль" min-width="140"><template #default="{ row }">{{ ROLES[row.role] || row.role }}</template></el-table-column>
          <el-table-column label="Последний вход" min-width="140"><template #default="{ row }"><span :title="fmtDateTime(row.lastLoginAt)">{{ ago(row.lastLoginAt) }}</span></template></el-table-column>
          <el-table-column label="2FA" width="70"><template #default="{ row }"><el-tag v-if="row.mfa" size="small" type="success">да</el-tag><span v-else class="muted">нет</span></template></el-table-column>
          <el-table-column label="" width="110"><template #default="{ row }"><el-tag v-if="!row.isActive" size="small" type="info">отключён</el-tag></template></el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>Торговые ({{ o.reps.length }})</template>
        <el-table :data="o.reps" size="small" empty-text="Торговых нет">
          <el-table-column label="Торговый" min-width="200"><template #default="{ row }">{{ row.name }}<div class="muted">{{ row.phone || 'без телефона' }}</div></template></el-table-column>
          <el-table-column label="Телефон с агентом" min-width="260">
            <template #default="{ row }">
              <div v-if="!row.devices.length" class="muted">не привязан</div>
              <div v-for="(d, i) in row.devices" :key="i" :class="{ revoked: !d.active }">
                {{ d.model || 'телефон' }}<span class="muted"> · агент {{ d.appVersion || '?' }} · на связи {{ ago(d.lastSeenAt) }}<template v-if="!d.active"> · отвязан</template></span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="" width="110"><template #default="{ row }"><el-tag v-if="!row.isActive" size="small" type="info">отключён</el-tag></template></el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>ИИ-помощник (Claude) — {{ o.ai.enabled === null ? 'компания раздел не открывала' : o.ai.enabled ? 'включён' : 'выключен компанией' }}</template>
        <el-table :data="o.ai.connections" size="small" empty-text="Claude не подключали">
          <el-table-column label="Кто подключил" min-width="200" prop="userEmail" />
          <el-table-column label="Приложение" min-width="130"><template #default="{ row }">{{ row.clientName || 'Claude' }}</template></el-table-column>
          <el-table-column label="Подключено" width="140"><template #default="{ row }">{{ fmtDateTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="Последний запрос" min-width="130"><template #default="{ row }">{{ ago(row.lastUsedAt) }}</template></el-table-column>
          <el-table-column label="" width="110"><template #default="{ row }"><el-tag v-if="row.revokedAt" size="small" type="info">отключено</el-tag></template></el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>История подписок</template>
        <el-table :data="o.events" size="small" empty-text="Изменений не было">
          <el-table-column label="Когда" width="140"><template #default="{ row }">{{ fmtDateTime(row.ts) }}</template></el-table-column>
          <el-table-column label="Решение" width="160"><template #default="{ row }">{{ nameOf(row.solution) }}</template></el-table-column>
          <el-table-column label="Было" min-width="180"><template #default="{ row }">{{ describeSub(row.before) }}</template></el-table-column>
          <el-table-column label="Стало" min-width="180"><template #default="{ row }">{{ describeSub(row.after) }}</template></el-table-column>
          <el-table-column label="Кто" min-width="160" prop="userEmail" />
        </el-table>
      </el-card>

      <SubscriptionDialog v-if="edit" v-model="editOpen" :org-id="o.id" :org-name="o.name" :solution="edit.code" :solution-name="edit.name"
        :on-by-default="edit.onByDefault" :state="o.solutions[edit.code]" :note="o.notes?.[edit.code]" @saved="load" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { ROLES, ago, describeSub, fmtDateTime, fmtDay, solutionLabel, solutionTag } from './admin'
import SubscriptionDialog from './SubscriptionDialog.vue'

const route = useRoute()
const solutions = ref<{ code: string; name: string; onByDefault: boolean }[]>([])
const o = ref<any>(null)
const loading = ref(false)
const edit = ref<any>(null)
const editOpen = ref(false)
const activeReps = computed(() => (o.value?.reps || []).filter((r: any) => r.isActive).length)
const nameOf = (code: string) => solutions.value.find((s) => s.code === code)?.name ?? code

async function load() {
  loading.value = true
  try { o.value = await api.get(`/platform/organizations/${route.params.id}`) } catch (e) { showError(e) }
  loading.value = false
}
function openEdit(s: any) { edit.value = s; editOpen.value = true }

onMounted(async () => {
  try { solutions.value = (await api.get('/platform/solutions')) as any } catch (e) { showError(e) }
  await load()
})
watch(() => route.params.id, (id) => { if (id) load() })
</script>

<style scoped>
.back { color: #0f766e; text-decoration: none; font-size: 13px; }
.head { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; }
.head h2 { margin: 0; font-size: 22px; }
.line { margin-top: 2px; }
.subs { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 16px 0; }
.subcard { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.sub-name { font-weight: 600; }
.note { font-style: italic; }
.mt { margin-top: 4px; }
.block { margin-top: 14px; }
.muted { color: #909399; font-size: 12px; }
.revoked { opacity: .55; }
</style>
