<template>
  <!-- «Супервайзер»: торговые представители и привязка их телефонов кодом из 6 цифр. -->
  <div>
    <div class="page-header"><PageIcon />
      <h1>Представители</h1>
      <el-button v-if="org.can('field.manage')" type="primary" :icon="Plus" @click="openEdit(null)">Добавить представителя</el-button>
    </div>
    <el-card>
      <p class="muted" style="margin-bottom: 12px;">
        Активных: <b>{{ active }}</b><template v-if="seats != null"> из {{ seats }} по подписке</template>.
        Представитель на сайт не входит: он работает в агенте на телефоне. Телефон привязывается одноразовым кодом.
      </p>
      <el-table :data="reps" v-loading="loading" size="small" empty-text="Представителей пока нет">
        <el-table-column label="Имя" min-width="180" prop="name" />
        <el-table-column label="Телефон" width="150" prop="phone" />
        <el-table-column label="Логин МойСклад" min-width="160" prop="moyskladLogin" />
        <el-table-column label="Телефон агента" min-width="230">
          <template #default="{ row }">
            <div v-for="d in row.devices" :key="d.id" class="device">
              <span>{{ d.model || 'телефон' }}<span class="muted"> · агент {{ d.appVersion || '—' }} · на связи {{ d.lastSeenAt ? kzDateTime(d.lastSeenAt) : '—' }}</span></span>
              <el-button v-if="org.can('field.manage')" link type="danger" size="small" @click="revoke(d)">Отвязать</el-button>
            </div>
            <span v-if="!row.devices?.length" class="muted">не привязан</span>
          </template>
        </el-table-column>
        <el-table-column label="Состояние" width="110">
          <template #default="{ row }"><el-tag :type="row.isActive ? 'success' : 'info'" size="small">{{ row.isActive ? 'Работает' : 'Отключён' }}</el-tag></template>
        </el-table-column>
        <el-table-column v-if="org.can('field.manage')" width="230" align="right">
          <template #default="{ row }">
            <el-button v-if="row.isActive" size="small" type="primary" plain @click="issueCode(row)">Привязать телефон</el-button>
            <el-button size="small" @click="openEdit(row)">Изменить</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="editDlg" :title="form.id ? 'Представитель' : 'Новый представитель'" width="480px">
      <el-form :model="form" label-width="150px">
        <el-form-item label="Имя"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Телефон"><el-input v-model="form.phone" placeholder="+7 …" /></el-form-item>
        <el-form-item label="Логин МойСклад"><el-input v-model="form.moyskladLogin" placeholder="как в агенте" /></el-form-item>
        <el-form-item v-if="form.id" label="Работает"><el-switch v-model="form.isActive" /></el-form-item>
        <p v-if="form.id && !form.isActive" class="muted">Отключённый представитель сразу теряет доступ с телефона.</p>
      </el-form>
      <template #footer><el-button @click="editDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="save">Сохранить</el-button></template>
    </el-dialog>

    <el-dialog v-model="codeDlg" title="Код привязки телефона" width="420px" @closed="stopTimer">
      <div v-if="code" class="code-box">
        <p>Представитель <b>{{ code.rep }}</b> вводит этот код в агенте: «Маршрут» → «Привязать».</p>
        <div class="code">{{ code.code.slice(0, 3) }} {{ code.code.slice(3) }}</div>
        <p v-if="left > 0" class="muted">Действует ещё {{ Math.floor(left / 60) }}:{{ String(left % 60).padStart(2, '0') }}, один раз.</p>
        <p v-else class="expired">Код истёк — выдайте новый.</p>
      </div>
      <template #footer><el-button @click="codeDlg = false">Закрыть</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'
import { kzDateTime } from './field'

const org = useOrgStore()
const reps = ref<any[]>([])
const seats = ref<number | null>(null)
const active = ref(0)
const loading = ref(false)
const busy = ref(false)
const editDlg = ref(false)
const form = ref<any>({})
const codeDlg = ref(false)
const code = ref<{ code: string; expiresAt: string; rep: string } | null>(null)
const left = ref(0)
let timer: number | undefined

async function load() {
  loading.value = true
  try {
    const r = (await api.get('/field/reps')) as any
    reps.value = r.reps
    seats.value = r.seats
    active.value = r.active
  } catch (e) { showError(e) }
  loading.value = false
}

function openEdit(row: any) {
  form.value = row ? { id: row.id, name: row.name, phone: row.phone, moyskladLogin: row.moyskladLogin, isActive: row.isActive } : { name: '', phone: '', moyskladLogin: '' }
  editDlg.value = true
}

async function save() {
  busy.value = true
  try {
    if (form.value.id) await api.put(`/field/reps/${form.value.id}`, form.value)
    else await api.post('/field/reps', form.value)
    editDlg.value = false
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

function tick() {
  left.value = code.value ? Math.max(0, Math.round((new Date(code.value.expiresAt).getTime() - Date.now()) / 1000)) : 0
}
function stopTimer() { if (timer) window.clearInterval(timer); timer = undefined }

async function issueCode(row: any) {
  try {
    const r = (await api.post(`/field/reps/${row.id}/bind-code`)) as any
    code.value = { ...r, rep: row.name }
    tick()
    stopTimer()
    timer = window.setInterval(tick, 1000)
    codeDlg.value = true
  } catch (e) { showError(e) }
}

async function revoke(d: any) {
  try {
    await ElMessageBox.confirm('Отвязать телефон? Агент на нём перестанет получать маршрут и отправлять посещения.', 'Отвязать телефон', { type: 'warning', confirmButtonText: 'Отвязать', cancelButtonText: 'Отмена' })
  } catch { return }
  try { await api.delete(`/field/devices/${d.id}`); ElMessage.success('Телефон отвязан'); await load() } catch (e) { showError(e) }
}

onMounted(load)
</script>

<style scoped>
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
.device { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.code-box { text-align: center; }
.code { font-size: 44px; font-weight: 700; letter-spacing: 6px; margin: 16px 0; font-variant-numeric: tabular-nums; }
.expired { color: #f56c6c; }
</style>
