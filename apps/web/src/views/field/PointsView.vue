<template>
  <!-- «Супервайзер»: торговые точки (клиенты) и их место на карте. -->
  <div>
    <div class="page-header"><PageIcon />
      <h1>Точки</h1>
      <el-button v-if="org.can('field.manage')" type="primary" :icon="Plus" @click="openEdit(null)">Добавить точку</el-button>
    </div>
    <el-card>
      <div class="filters">
        <el-input v-model="q" clearable placeholder="Название, адрес, телефон" style="width: 280px;" @change="load" />
        <el-checkbox v-model="all" @change="load">Показывать отключённые</el-checkbox>
        <el-segmented v-model="view" :options="[{ label: 'Список', value: 'list' }, { label: 'Карта', value: 'map' }]" />
      </div>
      <p class="muted">Клиенты из МойСклад появляются здесь сами, когда представитель обновляет список клиентов в агенте. Место точки ставится на карте здесь или запоминается представителем при первом посещении.</p>
      <el-table v-if="view === 'list'" :data="points" v-loading="loading" size="small" empty-text="Точек пока нет" style="cursor: pointer;" @row-click="openEdit">
        <el-table-column label="Название" min-width="220" prop="name" />
        <el-table-column label="Адрес" min-width="220" prop="address" />
        <el-table-column label="Телефон" width="140" prop="phone" />
        <el-table-column label="Место" width="190">
          <template #default="{ row }">
            <span v-if="row.lat != null">{{ row.coordsSource === 'rep' ? 'запомнил представитель' : 'на карте' }}<span class="muted"> · {{ row.radiusM || defaultRadius }} м</span></span>
            <el-tag v-else type="warning" size="small">не указано</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="МойСклад" width="100"><template #default="{ row }">{{ row.moyskladId ? 'да' : '—' }}</template></el-table-column>
        <el-table-column label="" width="100"><template #default="{ row }"><el-tag v-if="!row.isActive" type="info" size="small">Отключена</el-tag></template></el-table-column>
      </el-table>
      <FieldMap v-else :markers="mapMarkers" height="600px" />
    </el-card>

    <el-dialog v-model="editDlg" :title="form.id ? 'Точка' : 'Новая точка'" width="720px">
      <el-form :model="form" label-width="140px">
        <el-form-item label="Название"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Адрес"><el-input v-model="form.address" /></el-form-item>
        <el-form-item label="Телефон"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="Место">
          <div style="width: 100%;">
            <p class="muted">Щёлкните по карте, чтобы поставить точку.<template v-if="form.coordsSource === 'rep'"> Сейчас место запомнил представитель на посещении.</template></p>
            <FieldMap v-if="editDlg" :pickable="org.can('field.manage')" :picked="form.lat != null ? { lat: form.lat, lng: form.lng } : null" height="300px" @pick="(p) => { form.lat = p.lat; form.lng = p.lng }" />
            <div class="coords">
              <el-input v-model.number="form.lat" placeholder="широта" style="width: 140px;" />
              <el-input v-model.number="form.lng" placeholder="долгота" style="width: 140px;" />
              <el-button link @click="form.lat = null; form.lng = null">Убрать место</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="Радиус «на точке»"><el-input-number v-model="form.radiusM" :min="10" :max="5000" :step="10" placeholder="100" /> <span class="muted">&nbsp;м (пусто — {{ defaultRadius }} м)</span></el-form-item>
        <el-form-item v-if="form.id" label="Работает"><el-switch v-model="form.isActive" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDlg = false">Отмена</el-button>
        <el-button v-if="org.can('field.manage')" type="primary" :loading="busy" @click="save">Сохранить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'
import FieldMap from '@/components/field/FieldMap.vue'

const org = useOrgStore()
const points = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const q = ref('')
const all = ref(false)
const view = ref<'list' | 'map'>('list')
const editDlg = ref(false)
const form = ref<any>({})
const defaultRadius = 100

const mapMarkers = computed(() => points.value.filter((p) => p.lat != null).map((p) => ({
  lat: p.lat, lng: p.lng, color: p.isActive ? 'blue' : 'grey', label: '', title: `${p.name}${p.address ? '\n' + p.address : ''}`,
})))

async function load() {
  loading.value = true
  try { points.value = (await api.get('/field/points', { params: { q: q.value || undefined, all: all.value ? 1 : undefined } })) as any } catch (e) { showError(e) }
  loading.value = false
}

function openEdit(row: any) {
  form.value = row
    ? { id: row.id, name: row.name, address: row.address, phone: row.phone, lat: row.lat, lng: row.lng, radiusM: row.radiusM ?? undefined, isActive: row.isActive, coordsSource: row.coordsSource }
    : { name: '', address: '', phone: '', lat: null, lng: null, radiusM: undefined }
  editDlg.value = true
}

async function save() {
  busy.value = true
  try {
    const body: any = { name: form.value.name, address: form.value.address, phone: form.value.phone, radiusM: form.value.radiusM ?? null }
    const original = points.value.find((p) => p.id === form.value.id)
    // Координаты отправляем, только если их поменяли: иначе место от представителя стало бы «на карте».
    if (!original || original.lat !== form.value.lat || original.lng !== form.value.lng) {
      body.lat = form.value.lat === '' ? null : form.value.lat
      body.lng = form.value.lng === '' ? null : form.value.lng
    }
    if (form.value.id) { body.isActive = form.value.isActive; await api.put(`/field/points/${form.value.id}`, body) }
    else await api.post('/field/points', body)
    editDlg.value = false
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(load)
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; margin-bottom: 8px; }
.coords { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
</style>
