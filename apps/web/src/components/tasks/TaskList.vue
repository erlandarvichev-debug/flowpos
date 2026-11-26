<template>
  <!-- Список задач с быстрым добавлением. Используется на странице «Задачи» и в карточках документа/контрагента. -->
  <div class="tl">
    <div v-if="canAdd" class="add">
      <el-input v-model="draft.title" :placeholder="placeholder" class="add-title" @keyup.enter="add" />
      <el-date-picker v-model="draft.dueAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="DD.MM HH:mm" placeholder="Срок" style="width: 150px;" :default-time="defaultTime" />
      <el-select v-model="draft.assigneeId" filterable placeholder="Исполнитель" style="width: 180px;">
        <el-option v-for="u in assignees" :key="u.id" :label="u.name" :value="u.id" />
      </el-select>
      <el-button type="primary" :icon="Plus" :disabled="draft.title.trim().length < 2" :loading="busy" @click="add">Добавить</el-button>
    </div>

    <div v-loading="loading">
      <div v-if="!items.length && !loading" class="empty">{{ emptyText }}</div>
      <div v-for="t in (limit ? items.slice(0, limit) : items)" :key="t.id" class="task" :class="{ done: t.done, late: t.overdue }">
        <el-checkbox :model-value="t.done" @change="(v: any) => toggle(t, !!v)" />
        <div class="body" @click="open(t)">
          <div class="title">{{ t.title }}</div>
          <div class="meta">
            <span v-if="t.dueAt" :class="{ red: t.overdue }"><el-icon><Clock /></el-icon> {{ fmtDue(t.dueAt) }}{{ t.overdue ? ' — просрочено' : '' }}</span>
            <span v-if="t.assignee && showAssignee"><el-icon><User /></el-icon> {{ t.assignee.name }}</span>
            <span v-if="t.counterparty && !counterpartyId" class="lnk" @click.stop="router.push(`/catalog/counterparties/${t.counterparty.id}`)">{{ t.counterparty.name }}</span>
            <span v-if="t.document && !documentId" class="lnk" @click.stop="openDoc(t)">№ {{ t.document.number }}</span>
            <span v-if="t.comments.length"><el-icon><ChatLineRound /></el-icon> {{ t.comments.length }}</span>
          </div>
        </div>
      </div>
      <div v-if="limit && items.length > limit" class="more-tasks">и ещё {{ items.length - limit }} — во «Все задачи»</div>
    </div>

    <el-drawer v-model="show" :title="cur?.title" size="440px" append-to-body>
      <template v-if="cur">
        <el-form label-position="top">
          <el-form-item label="Задача"><el-input v-model="edit.title" /></el-form-item>
          <el-form-item label="Описание"><el-input v-model="edit.description" type="textarea" :rows="3" /></el-form-item>
          <el-form-item label="Срок">
            <el-date-picker v-model="edit.dueAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="DD.MM.YYYY HH:mm" clearable :default-time="defaultTime" />
          </el-form-item>
          <el-form-item label="Исполнитель">
            <el-select v-model="edit.assigneeId" filterable clearable style="width: 100%;"><el-option v-for="u in assignees" :key="u.id" :label="u.name" :value="u.id" /></el-select>
          </el-form-item>
        </el-form>
        <div class="muted small">Поставил {{ cur.author?.name }} {{ fmtDateTime(cur.createdAt) }}<template v-if="cur.done"> · выполнена {{ fmtDateTime(cur.doneAt) }}</template></div>
        <div class="drawer-btns">
          <el-button type="primary" :loading="busy" @click="save">Сохранить</el-button>
          <el-button :type="cur.done ? 'default' : 'success'" plain @click="toggle(cur, !cur.done)">{{ cur.done ? 'Вернуть в работу' : 'Выполнена' }}</el-button>
          <el-button v-if="cur.counterparty?.phone" :icon="ChatDotRound" @click="wa(cur)">WhatsApp</el-button>
          <el-popconfirm title="Удалить задачу?" @confirm="remove"><template #reference><el-button type="danger" link>Удалить</el-button></template></el-popconfirm>
        </div>
        <h4>Комментарии</h4>
        <div v-for="(c, i) in cur.comments" :key="i" class="cmt"><b>{{ c.author }}</b> <span class="muted small">{{ fmtDateTime(c.at) }}</span><div>{{ c.text }}</div></div>
        <div class="cmt-add">
          <el-input v-model="comment" type="textarea" :rows="2" placeholder="Комментарий или результат" />
          <el-button :disabled="!comment.trim()" @click="sendComment">Добавить</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ChatDotRound, ChatLineRound, Clock, Plus, User } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { fmtDateTime } from '@/utils/format'
import { showError } from '@/views/accounting/acc'

const props = withDefaults(defineProps<{
  scope?: 'mine' | 'created' | 'all'; done?: '0' | '1' | 'all'; overdue?: boolean; search?: string
  counterpartyId?: string; documentId?: string; documentKind?: 'TRADE' | 'ACC'; canAdd?: boolean; limit?: number; showAssignee?: boolean; emptyText?: string; placeholder?: string
}>(), { scope: 'mine', done: '0', canAdd: true, showAssignee: true, emptyText: 'Задач нет', placeholder: 'Что сделать? (Enter — добавить)' })
const emit = defineEmits<{ changed: [] }>()

const router = useRouter()
const auth = useAuthStore()
const items = ref<any[]>([])
const assignees = ref<{ id: string; name: string }[]>([])
const loading = ref(false)
const busy = ref(false)
const me = ref<string | null>(null)
const draft = ref({ title: '', dueAt: null as string | null, assigneeId: '' })
const show = ref(false)
const cur = ref<any>(null)
const edit = ref<any>({})
const comment = ref('')
const defaultTime = new Date(2000, 0, 1, 18, 0)

const kz = (iso: string) => new Date(new Date(iso).getTime() + 5 * 3600e3).toISOString()
const fmtDue = (iso: string) => { const s = kz(iso); return `${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}` }
const toLocal = (iso: string | null) => (iso ? kz(iso).slice(0, 16) : null)

async function load() {
  loading.value = true
  try {
    items.value = (await api.get('/accounting/tasks', { params: {
      scope: props.counterpartyId || props.documentId ? 'all' : props.scope, done: props.done, overdue: props.overdue ? '1' : undefined,
      counterpartyId: props.counterpartyId, documentId: props.documentId, search: props.search || undefined,
    } })) as any
  } catch (e) { showError(e) } finally { loading.value = false }
}
async function add() {
  const title = draft.value.title.trim()
  if (title.length < 2) return
  busy.value = true
  try {
    await api.post('/accounting/tasks', { title, dueAt: draft.value.dueAt || undefined, assigneeId: draft.value.assigneeId || undefined, counterpartyId: props.counterpartyId, documentId: props.documentId, documentKind: props.documentKind })
    draft.value = { title: '', dueAt: null, assigneeId: me.value ?? '' }
    await load()
    emit('changed')
  } catch (e) { showError(e) } finally { busy.value = false }
}
async function toggle(t: any, done: boolean) {
  try {
    const u = await api.post(`/accounting/tasks/${t.id}/done`, { done })
    if (cur.value?.id === t.id) cur.value = u
    await load()
    emit('changed')
  } catch (e) { showError(e) }
}
function open(t: any) {
  cur.value = t
  edit.value = { title: t.title, description: t.description ?? '', dueAt: toLocal(t.dueAt), assigneeId: t.assigneeId }
  comment.value = ''
  show.value = true
}
async function save() {
  busy.value = true
  try {
    cur.value = await api.put(`/accounting/tasks/${cur.value.id}`, { ...edit.value, dueAt: edit.value.dueAt || null })
    ElMessage.success('Сохранено')
    await load()
    emit('changed')
  } catch (e) { showError(e) } finally { busy.value = false }
}
async function sendComment() {
  try { cur.value = await api.post(`/accounting/tasks/${cur.value.id}/comments`, { text: comment.value }); comment.value = ''; load() } catch (e) { showError(e) }
}
async function remove() {
  try { await api.delete(`/accounting/tasks/${cur.value.id}`); show.value = false; await load(); emit('changed') } catch (e) { showError(e) }
}
function openDoc(t: any) { router.push(t.documentKind === 'ACC' ? `/accounting/documents/${t.document.id}` : `/accounting/trade/${t.document.id}`) }
function wa(t: any) {
  let d = String(t.counterparty.phone || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`
  if (d.length === 10) d = `7${d}`
  window.open(`https://wa.me/${d}`, '_blank', 'noopener')
}

watch(() => [props.scope, props.done, props.overdue, props.search, props.counterpartyId, props.documentId], load)
onMounted(async () => {
  load()
  try {
    me.value = auth.user?.id ?? null
    if (me.value) draft.value.assigneeId = me.value
    assignees.value = (await api.get('/accounting/assignees')) as any
  } catch { /* без справочника сотрудников — исполнитель = автор */ }
})
defineExpose({ load })
</script>

<style scoped>
.add { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.add-title { flex: 1 1 260px; }
.empty { color: var(--el-text-color-secondary); padding: 16px 4px; font-size: 13px; }
.task { display: flex; gap: 10px; align-items: flex-start; padding: 8px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.task .body { flex: 1; cursor: pointer; min-width: 0; }
.task .title { font-size: 14px; }
.task.done .title { text-decoration: line-through; color: var(--el-text-color-secondary); }
.task.late { background: var(--el-color-danger-light-9); }
.meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--el-text-color-secondary); margin-top: 2px; }
.meta span { display: inline-flex; align-items: center; gap: 3px; }
.red { color: var(--el-color-danger); }
.lnk { color: var(--el-color-primary); cursor: pointer; }
.muted { color: var(--el-text-color-secondary); }
.small { font-size: 12px; }
.drawer-btns { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.cmt { padding: 6px 0; border-bottom: 1px dashed var(--el-border-color-lighter); font-size: 13px; }
.cmt-add { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; align-items: flex-end; }
.more-tasks { font-size: 12px; color: var(--fp-text-3); padding: 8px 4px 0; order: 9; }
</style>
