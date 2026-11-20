<template>
  <!-- Администратор платформы: все организации всех клиентов и их подписки на решения. -->
  <div>
    <div class="page-header"><h1>Платформа: организации и подписки</h1></div>
    <el-card>
      <div class="filters">
        <el-input v-model="q" clearable placeholder="Название или БИН" style="width: 280px;" @change="load" />
        <span class="muted">Организаций: {{ orgs.length }}. «Учётная система» и «Бухгалтерия» у организации без подписки включены, как раньше; «Супервайзер» — только после подключения.</span>
      </div>
      <el-table :data="orgs" v-loading="loading" size="small" empty-text="Организаций нет">
        <el-table-column label="Организация" min-width="220">
          <template #default="{ row }">{{ row.name }}<div class="muted">{{ row.inn || 'без БИН' }} · создана {{ fmtDate(row.createdAt) }}</div></template>
        </el-table-column>
        <el-table-column label="Владелец" min-width="200">
          <template #default="{ row }"><div v-for="o in row.owners" :key="o.email">{{ o.name }}<div class="muted">{{ o.email }}</div></div></template>
        </el-table-column>
        <el-table-column label="Польз." width="70" align="right" prop="members" />
        <el-table-column v-for="s in solutions" :key="s.code" :label="s.name" min-width="230">
          <template #default="{ row }">
            <div class="sub">
              <el-tag :type="tagOf(row.solutions[s.code])" size="small">{{ labelOf(row.solutions[s.code]) }}</el-tag>
              <el-button link type="primary" size="small" @click="openEdit(row, s.code)">изменить</el-button>
            </div>
            <div class="muted">
              <template v-if="row.solutions[s.code].validUntil">до {{ fmtDate(row.solutions[s.code].validUntil) }}</template>
              <template v-if="s.code === 'supervisor' && row.solutions[s.code].status !== 'none'"> · представителей {{ row.reps }}<template v-if="row.solutions[s.code].seats != null"> из {{ row.solutions[s.code].seats }}</template></template>
              <template v-if="row.solutions[s.code].reason && row.solutions[s.code].status !== 'none'"> · {{ row.solutions[s.code].reason }}</template>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="editDlg" :title="`${form.orgName}: ${nameOf(form.solution)}`" width="560px">
      <el-form :model="form" label-width="150px">
        <el-form-item label="Состояние">
          <el-segmented v-model="form.status" :options="[{ label: 'Пробная', value: 'trial' }, { label: 'Действует', value: 'active' }, { label: 'Приостановлена', value: 'suspended' }]" />
        </el-form-item>
        <el-form-item label="Действует до"><el-date-picker v-model="form.validUntil" value-format="YYYY-MM-DD" format="DD.MM.YYYY" placeholder="без срока" /></el-form-item>
        <el-form-item v-if="form.solution === 'supervisor'" label="Мест (представителей)"><el-input-number v-model="form.seats" :min="0" :max="10000" placeholder="без ограничения" /></el-form-item>
        <el-form-item label="Примечание"><el-input v-model="form.note" type="textarea" :rows="2" placeholder="оплата, договор, контакт" /></el-form-item>
        <el-alert v-if="form.solution !== 'supervisor' && form.status === 'suspended'" type="warning" :closable="false" show-icon
          :title="`«${nameOf(form.solution)}» приостанавливается в меню сайта: разделы скрываются, данные сохраняются.`" />
      </el-form>
      <h4 style="margin: 12px 0 6px;">История</h4>
      <el-table :data="events" size="small" max-height="220" empty-text="Изменений не было">
        <el-table-column label="Когда" width="130"><template #default="{ row }">{{ fmtDateTime(row.ts) }}</template></el-table-column>
        <el-table-column label="Кто" min-width="150" prop="userEmail" />
        <el-table-column label="Стало" min-width="200"><template #default="{ row }">{{ describe(row.after) }}</template></el-table-column>
      </el-table>
      <template #footer><el-button @click="editDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="save">Сохранить</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { fmtDate, showError } from '../accounting/acc'
import { useSolutionsStore } from '@/stores/solutions'

const STATUS: Record<string, string> = { none: 'не подключено', trial: 'пробная', active: 'действует', suspended: 'приостановлена' }
const solutionsStore = useSolutionsStore()
const solutions = ref<{ code: string; name: string; label: string; onByDefault: boolean }[]>([])
const nameOf = (code: string) => solutions.value.find((s) => s.code === code)?.name ?? code
const onByDefault = (code: string) => !!solutions.value.find((s) => s.code === code)?.onByDefault
const orgs = ref<any[]>([])
const q = ref('')
const loading = ref(false)
const busy = ref(false)
const editDlg = ref(false)
const form = ref<any>({})
const events = ref<any[]>([])

function labelOf(s: any) {
  if (s.status === 'none') return onByDefault(s.solution) ? 'включено (по умолчанию)' : 'не подключено'
  return s.enabled ? STATUS[s.status] : `${STATUS[s.status]} · выключено`
}
function tagOf(s: any) { return s.enabled ? (s.status === 'trial' ? 'warning' : 'success') : 'info' }
function fmtDateTime(v: string) {
  const iso = new Date(new Date(v).getTime() + 5 * 3600 * 1000).toISOString()
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`
}
function describe(a: any) {
  if (!a) return '—'
  return [STATUS[a.status] || a.status, a.validUntil ? `до ${fmtDate(a.validUntil)}` : 'без срока', a.seats != null ? `мест ${a.seats}` : null, a.note].filter(Boolean).join(' · ')
}

async function load() {
  loading.value = true
  try { orgs.value = (await api.get('/platform/organizations', { params: { q: q.value || undefined } })) as any } catch (e) { showError(e) }
  loading.value = false
}

async function openEdit(row: any, solution: string) {
  const s = row.solutions[solution]
  // Срок хранится концом дня по Казахстану — показываем ту же дату.
  const until = s.validUntil ? new Date(new Date(s.validUntil).getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10) : null
  form.value = {
    orgId: row.id, orgName: row.name, solution,
    status: s.status === 'none' ? (onByDefault(solution) ? 'active' : 'trial') : s.status,
    validUntil: until, seats: s.seats ?? undefined, note: row.notes?.[solution] ?? '',
  }
  events.value = []
  editDlg.value = true
  try { events.value = ((await api.get(`/platform/organizations/${row.id}/events`)) as any).filter((e: any) => e.solution === solution) } catch { /* история не обязательна */ }
}

async function save() {
  busy.value = true
  try {
    await api.put(`/platform/organizations/${form.value.orgId}/subscriptions/${form.value.solution}`, {
      status: form.value.status, validUntil: form.value.validUntil || null, seats: form.value.seats ?? null, note: form.value.note || null,
    })
    ElMessage.success('Подписка сохранена')
    editDlg.value = false
    await load()
    await solutionsStore.load()
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(async () => {
  try { solutions.value = (await api.get('/platform/solutions')) as any } catch (e) { showError(e) }
  await load()
})
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.muted { color: #909399; font-size: 12px; }
.sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sub :deep(.el-button) { white-space: nowrap; }
</style>
