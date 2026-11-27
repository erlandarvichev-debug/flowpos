<template>
  <!-- «Супервайзер»: задания представителям — по точке или общие; выполняет представитель в агенте. -->
  <div>
    <div class="page-header">
      <h1>Задания</h1>
      <el-button v-if="org.can('field.manage')" type="primary" :icon="Plus" @click="openEdit(null)">Новое задание</el-button>
    </div>
    <el-card>
      <div class="filters">
        <el-select v-model="f.repId" clearable placeholder="Все представители" filterable style="width: 220px;" @change="load">
          <el-option v-for="r in reps" :key="r.id" :value="r.id" :label="r.name" />
        </el-select>
        <el-segmented v-model="f.status" :options="[{ label: 'Открытые', value: 'open' }, { label: 'Выполненные', value: 'done' }, { label: 'Отменённые', value: 'cancelled' }, { label: 'Все', value: '' }]" @change="load" />
      </div>
      <el-table :data="tasks" v-loading="loading" size="small" empty-text="Заданий нет">
        <el-table-column label="Что сделать" min-width="240">
          <template #default="{ row }">{{ row.title }}<div v-if="row.text" class="muted">{{ row.text }}</div></template>
        </el-table-column>
        <el-table-column label="Представитель" width="170"><template #default="{ row }">{{ repName(row.repId) }}</template></el-table-column>
        <el-table-column label="Точка" min-width="170"><template #default="{ row }">{{ row.pointId ? pointName(row.pointId) : 'любая' }}</template></el-table-column>
        <el-table-column label="Срок" width="100"><template #default="{ row }">{{ row.dueDate ? fmtDate(row.dueDate) : '—' }}</template></el-table-column>
        <el-table-column label="Состояние" width="120"><template #default="{ row }"><el-tag :type="TASK_STATUS[row.status]?.tag" size="small">{{ TASK_STATUS[row.status]?.label }}</el-tag></template></el-table-column>
        <el-table-column label="Результат" min-width="200">
          <template #default="{ row }">{{ row.result || '' }}<div v-if="row.doneAt" class="muted">{{ kzDateTime(row.doneAt) }}</div></template>
        </el-table-column>
        <el-table-column v-if="org.can('field.manage')" width="170" align="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'open'" link @click="openEdit(row)">Изменить</el-button>
            <el-button v-if="row.status === 'open'" link type="danger" @click="setStatus(row, 'cancelled')">Отменить</el-button>
            <el-button v-else link @click="setStatus(row, 'open')">Открыть снова</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="editDlg" :title="form.id ? 'Задание' : 'Новое задание'" width="520px">
      <el-form :model="form" label-width="140px">
        <el-form-item label="Представитель">
          <el-select v-model="form.repId" filterable :disabled="!!form.id" style="width: 100%;"><el-option v-for="r in reps.filter((x) => x.isActive)" :key="r.id" :value="r.id" :label="r.name" /></el-select>
        </el-form-item>
        <el-form-item label="Что сделать"><el-input v-model="form.title" placeholder="Например: сфотографировать выкладку" /></el-form-item>
        <el-form-item label="Подробно"><el-input v-model="form.text" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="Точка">
          <el-select v-model="form.pointId" filterable remote clearable :remote-method="searchPoints" :disabled="!!form.id" placeholder="любая" style="width: 100%;">
            <el-option v-for="p in pointOptions" :key="p.id" :value="p.id" :label="p.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="Срок"><el-date-picker v-model="form.dueDate" value-format="YYYY-MM-DD" format="DD.MM.YYYY" placeholder="без срока" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="editDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="save">Сохранить</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, showError } from '../accounting/acc'
import { TASK_STATUS, kzDateTime, loadReps, type Rep } from './field'

const org = useOrgStore()
const reps = ref<Rep[]>([])
const tasks = ref<any[]>([])
const points = ref<any[]>([])
const pointOptions = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const f = ref({ repId: '', status: 'open' })
const editDlg = ref(false)
const form = ref<any>({})

const repName = (id: string) => reps.value.find((r) => r.id === id)?.name ?? '—'
const pointName = (id: string) => points.value.find((p) => p.id === id)?.name ?? '—'

async function load() {
  loading.value = true
  try { tasks.value = (await api.get('/field/tasks', { params: { repId: f.value.repId || undefined, status: f.value.status || undefined } })) as any } catch (e) { showError(e) }
  loading.value = false
}

async function searchPoints(q: string) {
  try { pointOptions.value = ((await api.get('/field/points', { params: { q: q || undefined } })) as any).slice(0, 50) } catch { pointOptions.value = [] }
}

function openEdit(row: any) {
  form.value = row
    ? { id: row.id, repId: row.repId, title: row.title, text: row.text, pointId: row.pointId, dueDate: row.dueDate ? String(row.dueDate).slice(0, 10) : null }
    : { repId: f.value.repId || reps.value.find((r) => r.isActive)?.id, title: '', text: '', pointId: null, dueDate: null }
  editDlg.value = true
}

async function save() {
  busy.value = true
  try {
    if (form.value.id) await api.put(`/field/tasks/${form.value.id}`, { title: form.value.title, text: form.value.text, dueDate: form.value.dueDate })
    else await api.post('/field/tasks', form.value)
    editDlg.value = false
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

async function setStatus(row: any, status: string) {
  try { await api.put(`/field/tasks/${row.id}`, { status }); await load() } catch (e) { showError(e) }
}

onMounted(async () => {
  try {
    reps.value = await loadReps()
    points.value = (await api.get('/field/points', { params: { all: 1 } })) as any
    pointOptions.value = points.value.slice(0, 50)
  } catch (e) { showError(e) }
  await load()
})
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
