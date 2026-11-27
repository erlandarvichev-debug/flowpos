<template>
  <!-- «Супервайзер»: маршрут представителя на день — точки по порядку. -->
  <div>
    <div class="page-header"><h1>Маршруты</h1></div>
    <el-card>
      <div class="filters">
        <el-select v-model="repId" placeholder="Представитель" filterable style="width: 240px;" @change="load">
          <el-option v-for="r in reps" :key="r.id" :value="r.id" :label="r.name" :disabled="!r.isActive" />
        </el-select>
        <el-date-picker v-model="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" @change="load" />
        <el-button-group>
          <el-button @click="shift(-1)">‹ день</el-button>
          <el-button @click="shift(1)">день ›</el-button>
        </el-button-group>
      </div>
      <el-empty v-if="!repId" description="Выберите представителя" />
      <el-row v-else :gutter="16">
        <el-col :span="12">
          <h4>Точки маршрута ({{ stops.length }})</h4>
          <el-table :data="stops" size="small" empty-text="На этот день маршрута нет" v-loading="loading">
            <el-table-column label="№" width="50"><template #default="{ $index }">{{ $index + 1 }}</template></el-table-column>
            <el-table-column label="Точка" min-width="200">
              <template #default="{ row }">{{ row.name }}<div class="muted">{{ row.address }}</div></template>
            </el-table-column>
            <el-table-column v-if="canEdit" width="130" align="right">
              <template #default="{ $index }">
                <el-button link :disabled="$index === 0" @click="move($index, -1)">↑</el-button>
                <el-button link :disabled="$index === stops.length - 1" @click="move($index, 1)">↓</el-button>
                <el-button link type="danger" @click="stops.splice($index, 1); dirty = true">убрать</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="canEdit" class="add">
            <el-select v-model="adding" filterable remote :remote-method="searchPoints" placeholder="Добавить точку: название или адрес" style="flex: 1;" @change="addPoint">
              <el-option v-for="p in options" :key="p.id" :value="p.id" :label="p.name" :disabled="stops.some((s) => s.id === p.id)">
                <span>{{ p.name }}</span> <span class="muted">{{ p.address }}</span>
              </el-option>
            </el-select>
          </div>
          <el-input v-if="canEdit" v-model="note" type="textarea" :rows="2" placeholder="Комментарий к маршруту для представителя" style="margin-top: 8px;" @input="dirty = true" />
          <div v-if="canEdit" class="actions">
            <el-button type="primary" :loading="busy" :disabled="!dirty" @click="save">Сохранить маршрут</el-button>
            <el-button :disabled="!stops.length || dirty" @click="copyDlg = true">Копировать на другой день</el-button>
            <span v-if="dirty" class="warn">есть несохранённые изменения</span>
          </div>
        </el-col>
        <el-col :span="12">
          <FieldMap :markers="markers" :path="path" height="480px" />
        </el-col>
      </el-row>
    </el-card>

    <el-dialog v-model="copyDlg" title="Копировать маршрут" width="420px">
      <el-form label-width="140px">
        <el-form-item label="На дату"><el-date-picker v-model="copyTo" value-format="YYYY-MM-DD" format="DD.MM.YYYY" /></el-form-item>
        <el-form-item label="Представителю">
          <el-select v-model="copyRep" filterable style="width: 100%;"><el-option v-for="r in reps.filter((x) => x.isActive)" :key="r.id" :value="r.id" :label="r.name" /></el-select>
        </el-form-item>
        <p class="muted">Маршрут на выбранную дату будет заменён.</p>
      </el-form>
      <template #footer><el-button @click="copyDlg = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="copy">Копировать</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'
import FieldMap from '@/components/field/FieldMap.vue'
import { kzToday, loadReps, type Rep } from './field'

const org = useOrgStore()
const canEdit = computed(() => org.can('field.manage'))
const reps = ref<Rep[]>([])
const repId = ref('')
const date = ref(kzToday())
const stops = ref<any[]>([])
const note = ref('')
const dirty = ref(false)
const loading = ref(false)
const busy = ref(false)
const options = ref<any[]>([])
const adding = ref('')
const copyDlg = ref(false)
const copyTo = ref('')
const copyRep = ref('')

const markers = computed(() => stops.value.filter((p) => p.lat != null).map((p, i) => ({ lat: p.lat, lng: p.lng, label: String(stops.value.indexOf(p) + 1 || i + 1), color: 'blue', title: p.name })))
const path = computed(() => stops.value.filter((p) => p.lat != null).map((p) => [p.lat, p.lng] as [number, number]))

async function confirmLeave() {
  if (!dirty.value) return true
  try { await ElMessageBox.confirm('Маршрут изменён и не сохранён. Перейти без сохранения?', 'Не сохранено', { type: 'warning', confirmButtonText: 'Перейти', cancelButtonText: 'Остаться' }); return true } catch { return false }
}

async function load() {
  if (!repId.value) return
  loading.value = true
  try {
    const r = (await api.get('/field/routes', { params: { repId: repId.value, date: date.value } })) as any
    stops.value = r.stops.map((s: any) => s.point).filter(Boolean)
    note.value = r.note || ''
    dirty.value = false
  } catch (e) { showError(e) }
  loading.value = false
}

async function shift(days: number) {
  if (!(await confirmLeave())) return
  const d = new Date(`${date.value}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  date.value = d.toISOString().slice(0, 10)
  await load()
}

async function searchPoints(q: string) {
  try { options.value = ((await api.get('/field/points', { params: { q: q || undefined } })) as any).slice(0, 50) } catch { options.value = [] }
}

function addPoint(id: string) {
  const p = options.value.find((x) => x.id === id)
  if (p && !stops.value.some((s) => s.id === id)) { stops.value.push(p); dirty.value = true }
  adding.value = ''
}

function move(i: number, d: number) {
  const [x] = stops.value.splice(i, 1)
  stops.value.splice(i + d, 0, x)
  dirty.value = true
}

async function save() {
  busy.value = true
  try {
    await api.put('/field/routes', { repId: repId.value, date: date.value, note: note.value, pointIds: stops.value.map((s) => s.id) })
    ElMessage.success(stops.value.length ? 'Маршрут сохранён' : 'Маршрут на этот день удалён')
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

async function copy() {
  if (!copyTo.value) return ElMessage.warning('Выберите дату')
  busy.value = true
  try {
    await api.post('/field/routes/copy', { repId: repId.value, from: date.value, to: copyTo.value, toRepId: copyRep.value || repId.value })
    ElMessage.success('Маршрут скопирован')
    copyDlg.value = false
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(async () => {
  try { reps.value = await loadReps() } catch (e) { showError(e) }
  const first = reps.value.find((r) => r.isActive)
  if (first) { repId.value = first.id; copyRep.value = first.id; await load() }
  await searchPoints('')
})
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.add { display: flex; gap: 8px; margin-top: 12px; }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
.warn { color: #e6a23c; font-size: 13px; }
h4 { margin-bottom: 8px; }
</style>
