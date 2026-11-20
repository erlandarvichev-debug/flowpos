<template>
  <!-- «Супервайзер»: день представителя на карте — план (маршрут), посещения, заказы, путь по отметкам. -->
  <div>
    <div class="page-header"><h1>День на карте</h1></div>
    <el-card>
      <div class="filters">
        <el-select v-model="repId" placeholder="Представитель" filterable style="width: 240px;" @change="load">
          <el-option v-for="r in reps" :key="r.id" :value="r.id" :label="r.name" />
        </el-select>
        <el-date-picker v-model="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" @change="load" />
        <span class="legend"><i class="dot blue" /> в плане, не был <i class="dot green" /> на точке <i class="dot orange" /> удалённо <i class="dot grey" /> не определено</span>
      </div>
      <el-empty v-if="!repId" description="Выберите представителя" />
      <el-row v-else :gutter="16" v-loading="loading">
        <el-col :span="16">
          <FieldMap :markers="markers" :path="path" height="600px" />
          <p v-if="noCoords" class="muted">Без места на карте: {{ noCoords }} — поставьте место в «Точках».</p>
        </el-col>
        <el-col :span="8">
          <h4>План: {{ planVisited }} из {{ plan.length }} точек</h4>
          <ol class="plan">
            <li v-for="s in plan" :key="s.point.id" :class="{ done: visitedPoints.has(s.point.id) }">{{ s.point.name }}</li>
          </ol>
          <h4>Хронология</h4>
          <el-timeline>
            <el-timeline-item v-for="e in timeline" :key="e.key" :timestamp="kzTime(e.at)" :type="e.type" size="normal">{{ e.text }}</el-timeline-item>
          </el-timeline>
          <p v-if="!timeline.length" class="muted">За день отметок нет.</p>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import FieldMap, { type MapMarker } from '@/components/field/FieldMap.vue'
import { PLACEMENT, fmtDistance, fmtSum, kzTime, kzToday, loadReps, type Rep } from './field'

const reps = ref<Rep[]>([])
const repId = ref('')
const date = ref(kzToday())
const data = ref<any>(null)
const loading = ref(false)

const plan = computed(() => (data.value?.route?.stops ?? []).filter((s: any) => s.point))
const visitedPoints = computed(() => new Set<string>((data.value?.visits ?? []).map((v: any) => v.pointId)))
const planVisited = computed(() => plan.value.filter((s: any) => visitedPoints.value.has(s.point.id)).length)
const noCoords = computed(() => plan.value.filter((s: any) => s.point.lat == null).map((s: any) => s.point.name).join(', '))
const COLOR: Record<string, string> = { on_site: 'green', remote: 'orange', unknown: 'grey' }

const markers = computed<MapMarker[]>(() => {
  const out: MapMarker[] = []
  plan.value.forEach((s: any, i: number) => {
    if (s.point.lat == null || visitedPoints.value.has(s.point.id)) return
    out.push({ lat: s.point.lat, lng: s.point.lng, label: String(i + 1), color: 'blue', title: `${i + 1}. ${s.point.name}\nне посещена`, radiusM: s.point.radiusM || 100 })
  })
  for (const v of data.value?.visits ?? []) {
    const p = v.point
    const lat = p?.lat ?? v.lat
    const lng = p?.lng ?? v.lng
    if (lat == null) continue
    const n = plan.value.findIndex((s: any) => s.point.id === v.pointId)
    out.push({ lat, lng, label: n >= 0 ? String(n + 1) : '+', color: COLOR[v.placement], title: `${p?.name ?? 'точка'}\n${kzTime(v.startedAt)} · ${PLACEMENT[v.placement].label}${v.distanceM != null ? ' · ' + fmtDistance(v.distanceM) : ''}`, radiusM: p?.radiusM || 100 })
  }
  return out
})

const path = computed(() => (data.value?.track ?? []).map((t: any) => [t.lat, t.lng] as [number, number]))

const timeline = computed(() => {
  const ev: any[] = []
  for (const v of data.value?.visits ?? []) ev.push({ key: 'v' + v.id, at: v.startedAt, type: v.placement === 'on_site' ? 'success' : v.placement === 'remote' ? 'warning' : 'info', text: `Посещение: ${v.point?.name ?? '—'} — ${PLACEMENT[v.placement].label}` })
  for (const o of data.value?.orders ?? []) ev.push({ key: 'o' + o.id, at: o.at, type: o.placement === 'on_site' ? 'success' : o.placement === 'remote' ? 'warning' : 'info', text: `Заказ ${o.number || ''} на ${fmtSum(o.sum)} — ${PLACEMENT[o.placement].label}` })
  return ev.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
})

async function load() {
  if (!repId.value) return
  loading.value = true
  try { data.value = await api.get('/field/day', { params: { repId: repId.value, date: date.value } }) } catch (e) { showError(e) }
  loading.value = false
}

onMounted(async () => {
  try { reps.value = await loadReps() } catch (e) { showError(e) }
  const first = reps.value.find((r) => r.isActive)
  if (first) { repId.value = first.id; await load() }
})
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.muted { color: #909399; font-size: 12px; margin-top: 6px; }
.legend { font-size: 12px; color: #606266; display: flex; align-items: center; gap: 6px; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-left: 8px; }
.dot.blue { background: #409eff; } .dot.green { background: #67c23a; } .dot.orange { background: #e6a23c; } .dot.grey { background: #909399; }
.plan { padding-left: 20px; margin-bottom: 16px; font-size: 13px; }
.plan li.done { color: #67c23a; }
.plan li.done::after { content: ' ✓'; }
h4 { margin: 4px 0 8px; }
</style>
