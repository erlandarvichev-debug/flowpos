<template>
  <!-- ИИ-помощник компании: свой адрес коннектора для Claude, включение, подключения. -->
  <div>
    <div class="page-header"><h1>ИИ-помощник (Claude)</h1></div>

    <el-card v-loading="loading" shadow="never">
      <template v-if="conn">
        <div class="state">
          <el-tag :type="conn.enabled ? 'success' : 'info'">{{ conn.enabled ? 'Включён' : 'Выключен' }}</el-tag>
          <span class="muted">Компания: <b>{{ orgName }}</b></span>
          <el-switch v-if="canManage" :model-value="conn.enabled" :loading="busy" active-text="включён" @change="(v: any) => setEnabled(!!v)" class="ml" />
        </div>

        <p class="lead">
          Claude может отвечать на вопросы по данным <b>этой компании</b>: продажи, остатки, долги, документы, ЭСФ —
          в пределах прав сотрудника, который его подключил. Создавать он может только черновики; проводить, подписывать и удалять — нет.
        </p>

        <h3>Адрес коннектора компании</h3>
        <div class="url">
          <el-input :model-value="url" readonly class="url-input" />
          <el-button type="primary" @click="copy">Скопировать</el-button>
        </div>
        <p class="muted">Адрес — только для сотрудников компании: при подключении Claude попросит войти логином FlowPOS, и войти сможет только сотрудник этой компании.</p>

        <h3>Как подключить</h3>
        <ol class="steps">
          <li>Откройте Claude (claude.ai или приложение) → <b>Настройки → Коннекторы → Добавить свой коннектор</b>.</li>
          <li>Вставьте адрес выше, название — «FlowPOS {{ orgName }}».</li>
          <li>Нажмите «Подключить» и войдите своим логином и паролем FlowPOS.</li>
          <li>В чате спросите, например: «Какие продажи за неделю?» или «Кто из покупателей должен больше всех?»</li>
        </ol>

        <div v-if="canManage" class="danger">
          <el-button :loading="busy" @click="rotate">Сменить адрес</el-button>
          <span class="muted">Старый адрес перестанет работать, все подключения отключатся — например, если адрес попал к посторонним.</span>
        </div>
      </template>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>Подключения</template>
      <el-table :data="list" size="small" empty-text="Claude к этой компании ещё не подключали">
        <el-table-column label="Кто подключил" min-width="200"><template #default="{ row }">{{ row.userName || '—' }}<div class="muted">{{ row.userEmail }}</div></template></el-table-column>
        <el-table-column label="Приложение" min-width="140"><template #default="{ row }">{{ row.clientName || 'Claude' }}</template></el-table-column>
        <el-table-column label="Подключено" width="140"><template #default="{ row }">{{ fmt(row.createdAt) }}</template></el-table-column>
        <el-table-column label="Последний запрос" width="150"><template #default="{ row }">{{ row.lastUsedAt ? fmt(row.lastUsedAt) : '—' }}</template></el-table-column>
        <el-table-column label="" width="150">
          <template #default="{ row }">
            <el-tag v-if="!row.active" size="small" type="info">отключено</el-tag>
            <el-button v-else-if="canManage || row.mine" size="small" type="danger" plain @click="revoke(row)">Отключить</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'

const org = useOrgStore()
const conn = ref<any>(null)
const list = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const canManage = computed(() => org.can('org.members.manage'))
const orgName = computed(() => (org as any).current?.name ?? '')
const url = computed(() => (conn.value ? `${location.origin}/mcp/c/${conn.value.code}` : ''))

function fmt(v: string) {
  const iso = new Date(new Date(v).getTime() + 5 * 3600 * 1000).toISOString()
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`
}

async function load() {
  loading.value = true
  try {
    const [c, l] = await Promise.all([api.get('/ai/connector'), api.get('/ai/connections')])
    conn.value = c
    list.value = l as any
  } catch (e) { showError(e) }
  loading.value = false
}

async function copy() {
  try { await navigator.clipboard.writeText(url.value); ElMessage.success('Адрес скопирован') } catch { ElMessage.warning('Скопируйте адрес вручную') }
}

async function setEnabled(enabled: boolean) {
  busy.value = true
  try { conn.value = await api.put('/ai/connector', { enabled }); ElMessage.success(enabled ? 'ИИ-помощник включён' : 'ИИ-помощник выключен: Claude больше не получит данные компании') } catch (e) { showError(e) }
  busy.value = false
}

async function rotate() {
  try {
    await ElMessageBox.confirm('Старый адрес перестанет работать, все подключения Claude к компании отключатся. Сменить?', 'Сменить адрес коннектора', { type: 'warning', confirmButtonText: 'Сменить', cancelButtonText: 'Отмена' })
  } catch { return }
  busy.value = true
  try { conn.value = await api.post('/ai/connector/rotate'); await load(); ElMessage.success('Адрес сменён') } catch (e) { showError(e) }
  busy.value = false
}

async function revoke(row: any) {
  try {
    await ElMessageBox.confirm(`Отключить Claude у ${row.userEmail || 'пользователя'}? Он перестанет получать данные компании сразу.`, 'Отключить подключение', { type: 'warning', confirmButtonText: 'Отключить', cancelButtonText: 'Отмена' })
  } catch { return }
  try { await api.delete(`/ai/connections/${row.id}`); await load() } catch (e) { showError(e) }
}

onMounted(load)
watch(() => (org as any).currentId, () => load())
</script>

<style scoped>
.state { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ml { margin-left: auto; }
.lead { margin: 14px 0 6px; color: var(--el-text-color-regular); line-height: 1.55; }
h3 { margin: 18px 0 8px; font-size: 15px; }
.url { display: flex; gap: 8px; }
.url-input { flex: 1; min-width: 0; }
.url-input :deep(input) { font-family: ui-monospace, Consolas, monospace; }
.steps { margin: 0; padding-left: 20px; line-height: 1.8; color: var(--el-text-color-regular); }
.danger { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 18px; padding-top: 14px; border-top: 1px solid #f1f5f9; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.block { margin-top: 14px; }
</style>
