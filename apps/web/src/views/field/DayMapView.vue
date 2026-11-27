<template>
  <!-- «Супервайзер»: карта торговых за день — все сразу или один торговый: где сейчас, путь, маршрут, посещения, заказы. -->
  <div class="live">
    <div class="page-header bar">
      <div>
        <h1>Карта торговых</h1>
        <div class="sub">
          <template v-if="isToday && auto">Обновляется каждую минуту · </template>
          <template v-if="updatedAt">обновлено в {{ updatedAt }}</template>
        </div>
      </div>
      <div class="tools">
        <el-button-group>
          <el-button :icon="ArrowLeft" @click="shift(-1)" />
          <el-button :type="isToday ? 'primary' : 'default'" @click="setDate(kzToday())">Сегодня</el-button>
          <el-button :icon="ArrowRight" :disabled="isToday" @click="shift(1)" />
        </el-button-group>
        <el-date-picker v-model="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 140px;" @change="reload(true)" />
        <el-switch v-if="isToday" v-model="auto" active-text="Авто" />
        <el-button :icon="Refresh" :loading="loading" @click="reload(false)">Обновить</el-button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi">
        <div class="k-label">Торговые в работе</div>
        <div class="k-value">{{ kpi.working }} <small>из {{ kpi.reps }}</small></div>
        <div class="k-hint"><span v-if="kpi.inVisit" class="ok">{{ kpi.inVisit }} на посещении</span><span v-if="kpi.stale" class="bad"> · {{ kpi.stale }} нет связи</span></div>
      </div>
      <div class="kpi">
        <div class="k-label">Маршруты</div>
        <div class="k-value">{{ kpi.planVisited }} <small>из {{ kpi.plan }} точек</small></div>
        <el-progress :percentage="pct(kpi.planVisited, kpi.plan)" :stroke-width="6" :show-text="false" :color="progressColor(pct(kpi.planVisited, kpi.plan))" />
      </div>
      <div class="kpi">
        <div class="k-label">Посещения</div>
        <div class="k-value">{{ kpi.visits }}</div>
        <div class="k-hint"><span class="ok">{{ kpi.onSite }} на точке</span><span v-if="kpi.remote" class="warn"> · {{ kpi.remote }} удалённо</span> · {{ kpi.photos }} фото</div>
      </div>
      <div class="kpi accent">
        <div class="k-label">Заказы за день</div>
        <div class="k-value">{{ fmtSum(kpi.sum) }}</div>
        <div class="k-hint">{{ kpi.orders }} {{ plural(kpi.orders, 'заказ', 'заказа', 'заказов') }}<template v-if="kpi.orders"> · средний {{ fmtSum(kpi.sum / kpi.orders) }}</template></div>
      </div>
    </div>

    <div class="body">
      <div class="map-wrap">
        <FieldMap ref="mapRef" :markers="markers" :paths="paths" :fit-key="fitKey" height="100%" @select="onSelect" />
        <div class="layers">
          <el-checkbox v-model="show.points" size="small">Точки</el-checkbox>
          <el-checkbox v-model="show.paths" size="small">Пути</el-checkbox>
          <el-button size="small" link type="primary" @click="mapRef?.fitAll()">Показать всё</el-button>
        </div>
        <div class="legend">
          <template v-if="selected">
            <span><i class="dot" style="background:#409eff" /> в маршруте, не был</span>
            <span><i class="dot" style="background:#67c23a" /> на точке</span>
            <span><i class="dot" style="background:#e6a23c" /> удалённо</span>
            <span><i class="dot" style="background:#909399" /> не определено</span>
          </template>
          <template v-else>
            <span><i class="dot" style="background:#cbd5e1" /> точка</span>
            <span><i class="dot" style="background:#409eff" /> в маршруте</span>
            <span><i class="dot" style="background:#67c23a" /> посещена</span>
            <span><i class="dot" style="background:#f59e0b" /> есть заказ</span>
          </template>
        </div>
      </div>

      <aside class="side">
        <!-- Все торговые -->
        <template v-if="!selected">
          <div class="side-head">
            <b>Торговые</b>
            <el-input v-model="q" size="small" placeholder="Поиск" clearable style="width: 150px;" />
          </div>
          <el-empty v-if="!loading && !reps.length" description="Нет торговых. Добавьте их в «Представителях»." :image-size="70" />
          <div class="rep-list">
            <button v-for="r in filteredReps" :key="r.id" class="rep" @click="select(r.id)">
              <span class="avatar" :style="{ background: r.color }">{{ initials(r.name) }}</span>
              <span class="rep-body">
                <span class="rep-top">
                  <span class="rep-name">{{ r.name }}</span>
                  <el-tag :type="STATUS[r.status as Status].tag" size="small" effect="light" round>{{ STATUS[r.status as Status].label }}</el-tag>
                </span>
                <span class="rep-meta">
                  <template v-if="r.status === 'visit' && r.openVisit">{{ pointName(r.openVisit.pointId) }} · с {{ kzTime(r.openVisit.startedAt) }}</template>
                  <template v-else-if="r.lastAt">Последняя отметка {{ isToday ? fmtAgo(r.lastAt) : 'в ' + kzTime(r.lastAt) }}</template>
                  <template v-else-if="!r.bound">Телефон не привязан</template>
                  <template v-else>За день отметок нет</template>
                </span>
                <span v-if="r.plan.length" class="rep-plan">
                  <el-progress :percentage="pct(r.planVisited, r.plan.length)" :stroke-width="5" :show-text="false" :color="progressColor(pct(r.planVisited, r.plan.length))" />
                  <span>{{ r.planVisited }}/{{ r.plan.length }}</span>
                </span>
                <span class="rep-stats">
                  <span>{{ r.visits }} посещ.</span>
                  <span>{{ r.orders }} заказ.</span>
                  <b>{{ fmtSum(r.ordersSum) }}</b>
                </span>
              </span>
            </button>
          </div>
        </template>

        <!-- Один торговый -->
        <template v-else>
          <div class="side-head">
            <el-button link :icon="ArrowLeft" @click="select('')">Все торговые</el-button>
          </div>
          <div class="who">
            <span class="avatar big" :style="{ background: selected.color }">{{ initials(selected.name) }}</span>
            <div>
              <div class="who-name">{{ selected.name }}</div>
              <div class="rep-meta">
                <el-tag :type="STATUS[selected.status as Status].tag" size="small" round>{{ STATUS[selected.status as Status].label }}</el-tag>
                <span v-if="selected.phone"> · {{ selected.phone }}</span>
              </div>
            </div>
          </div>
          <div class="mini">
            <div><b>{{ selected.planVisited }}/{{ selected.plan.length }}</b><span>маршрут</span></div>
            <div><b>{{ selected.visits }}</b><span>посещений</span></div>
            <div><b>{{ selected.orders }}</b><span>заказов</span></div>
            <div><b>{{ fmtSum(selected.ordersSum) }}</b><span>сумма</span></div>
          </div>
          <div class="who-links">
            <router-link :to="{ path: '/field/visits', query: { date, repId: selected.id } }">Посещения с фото</router-link>
            <router-link :to="{ path: '/field/sales', query: { repId: selected.id } }">Продажи торгового</router-link>
          </div>

          <h4>Маршрут на день</h4>
          <p v-if="!selected.plan.length" class="muted">Маршрута на этот день нет.</p>
          <ol class="plan">
            <li v-for="(pid, i) in selected.plan" :key="pid" :class="planClass(pid)" @click="focusPoint(pid)">
              <span class="num">{{ i + 1 }}</span>
              <span class="p-name">{{ pointName(pid) }}</span>
              <span class="p-state">{{ planState(pid) }}</span>
            </li>
          </ol>

          <h4>Хронология</h4>
          <el-timeline v-if="timeline.length">
            <el-timeline-item v-for="e in timeline" :key="e.key" :timestamp="kzTime(e.at)" :type="e.type" placement="top">
              {{ e.text }}
            </el-timeline-item>
          </el-timeline>
          <p v-else class="muted">За день отметок нет.</p>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, ArrowRight, Refresh } from '@element-plus/icons-vue'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import FieldMap, { type MapMarker, type MapPath } from '@/components/field/FieldMap.vue'
import { PLACEMENT, fmtAgo, fmtDistance, fmtSum, initials, kzShift, kzTime, kzToday, repColor } from './field'

type Status = 'visit' | 'active' | 'stale' | 'idle'
const STATUS: Record<Status, { label: string; tag: 'success' | 'primary' | 'danger' | 'info' }> = {
  visit: { label: 'На посещении', tag: 'success' },
  active: { label: 'В работе', tag: 'primary' },
  stale: { label: 'Нет связи', tag: 'danger' },
  idle: { label: 'Не начинал', tag: 'info' },
}
const PLACEMENT_COLOR: Record<string, string> = { on_site: '#67c23a', remote: '#e6a23c', unknown: '#909399' }

const route = useRoute()
const router = useRouter()
const mapRef = ref<InstanceType<typeof FieldMap> | null>(null)
const date = ref(String(route.query.date || kzToday()))
const selectedId = ref(String(route.query.repId || ''))
const data = ref<any>(null)
const loading = ref(false)
const auto = ref(true)
const updatedAt = ref('')
const q = ref('')
const show = reactive({ points: true, paths: true })
/** Меняется при смене дня или торгового — только тогда карта подгоняет масштаб. */
const fitKey = computed(() => `${date.value}|${selectedId.value}|${data.value ? 1 : 0}`)

const isToday = computed(() => date.value === kzToday())
const reps = computed<any[]>(() => (data.value?.reps ?? []).map((r: any) => ({ ...r, color: repColor(r.idx) })))
const filteredReps = computed(() => {
  const s = q.value.trim().toLowerCase()
  const order: Record<Status, number> = { visit: 0, active: 1, stale: 2, idle: 3 }
  return reps.value
    .filter((r) => !s || r.name.toLowerCase().includes(s))
    .sort((a, b) => order[a.status as Status] - order[b.status as Status] || b.ordersSum - a.ordersSum)
})
const selected = computed(() => reps.value.find((r) => r.id === selectedId.value) ?? null)
const pointsById = computed(() => new Map<string, any>((data.value?.points ?? []).map((p: any) => [p.id, p])))
const pointName = (id: string) => pointsById.value.get(id)?.name ?? 'Точка'

const kpi = computed(() => {
  const rs = reps.value
  return {
    reps: rs.filter((r) => r.isActive).length,
    working: rs.filter((r) => r.status !== 'idle').length,
    inVisit: rs.filter((r) => r.status === 'visit').length,
    stale: rs.filter((r) => r.status === 'stale').length,
    plan: rs.reduce((n, r) => n + r.plan.length, 0),
    planVisited: rs.reduce((n, r) => n + r.planVisited, 0),
    visits: rs.reduce((n, r) => n + r.visits, 0),
    onSite: rs.reduce((n, r) => n + r.onSite, 0),
    remote: rs.reduce((n, r) => n + r.remote, 0),
    photos: rs.reduce((n, r) => n + r.photos, 0),
    orders: rs.reduce((n, r) => n + r.orders, 0),
    sum: rs.reduce((s, r) => s + r.ordersSum, 0),
  }
})

const repVisits = computed<any[]>(() => (data.value?.visits ?? []).filter((v: any) => v.repId === selectedId.value))
const repOrders = computed<any[]>(() => (data.value?.orders ?? []).filter((o: any) => o.repId === selectedId.value))
const visitOf = (pid: string) => repVisits.value.find((v) => v.pointId === pid)
const orderSumOf = (pid: string) => repOrders.value.filter((o) => o.pointId === pid).reduce((s, o) => s + o.sum, 0)

function planClass(pid: string) {
  const v = visitOf(pid)
  return v ? `done ${v.placement}` : ''
}
function planState(pid: string) {
  const v = visitOf(pid)
  if (!v) return 'не был'
  const sum = orderSumOf(pid)
  return `${kzTime(v.startedAt)} · ${PLACEMENT[v.placement].label.toLowerCase()}${sum ? ' · ' + fmtSum(sum) : ''}`
}

const markers = computed<MapMarker[]>(() => {
  const out: MapMarker[] = []
  const sel = selected.value
  if (!sel) {
    if (show.points) {
      for (const p of data.value?.points ?? []) {
        if (p.lat == null) continue
        const color = p.orderSum ? '#f59e0b' : p.visited ? '#67c23a' : p.inPlan ? '#409eff' : '#cbd5e1'
        const state = p.orderSum ? `\nЗаказ: ${fmtSum(p.orderSum)}` : p.visited ? '\nПосещена' : p.inPlan ? '\nВ маршруте' : ''
        out.push({ lat: p.lat, lng: p.lng, kind: 'dot', color, title: `${p.name}${p.address ? '\n' + p.address : ''}${state}` })
      }
    }
    for (const r of reps.value) {
      if (!r.last) continue
      out.push({
        id: r.id, kind: 'rep', lat: r.last.lat, lng: r.last.lng, color: r.color, label: initials(r.name), pulse: r.status === 'visit',
        title: `${r.name} — ${STATUS[r.status as Status].label}\nОтметка в ${kzTime(r.last.at)}\n${r.visits} посещ. · ${r.orders} заказ. · ${fmtSum(r.ordersSum)}`,
      })
    }
    return out
  }
  // Один торговый: маршрут по номерам, посещения цветом места, последняя отметка.
  const visitedPids = new Set(repVisits.value.map((v) => v.pointId))
  sel.plan.forEach((pid: string, i: number) => {
    const p = pointsById.value.get(pid)
    if (!p || p.lat == null || visitedPids.has(pid)) return
    out.push({ lat: p.lat, lng: p.lng, label: String(i + 1), color: 'blue', title: `${i + 1}. ${p.name}\nне посещена`, radiusM: p.radiusM })
  })
  for (const v of repVisits.value) {
    const p = pointsById.value.get(v.pointId)
    const lat = p?.lat ?? v.lat
    const lng = p?.lng ?? v.lng
    if (lat == null) continue
    const n = sel.plan.indexOf(v.pointId)
    const sum = orderSumOf(v.pointId)
    out.push({
      lat, lng, label: n >= 0 ? String(n + 1) : '+', color: PLACEMENT_COLOR[v.placement] ?? '#909399', radiusM: p?.radiusM,
      title: `${p?.name ?? 'Точка'}\n${kzTime(v.startedAt)}${v.finishedAt ? '–' + kzTime(v.finishedAt) : ''} · ${PLACEMENT[v.placement].label}${v.distanceM != null ? ' · ' + fmtDistance(v.distanceM) : ''}${v.photos ? '\nФото: ' + v.photos : ''}${sum ? '\nЗаказ: ' + fmtSum(sum) : ''}`,
    })
  }
  if (sel.last) out.push({ kind: 'rep', lat: sel.last.lat, lng: sel.last.lng, color: sel.color, label: initials(sel.name), pulse: sel.status === 'visit', title: `${sel.name}\nОтметка в ${kzTime(sel.last.at)}` })
  return out
})

const paths = computed<MapPath[]>(() => {
  if (!show.paths) return []
  const list = selected.value ? [selected.value] : reps.value
  return list.filter((r) => r.track.length > 1).map((r) => ({ points: r.track, color: r.color, dashed: !selected.value, weight: selected.value ? 4 : 3 }))
})

const timeline = computed(() => {
  const ev: any[] = []
  for (const v of repVisits.value) {
    const extra = `${v.photos ? `, фото ${v.photos}` : ''}${v.comment ? ` · «${v.comment}»` : ''}`
    ev.push({ key: 'v' + v.id, at: v.startedAt, type: v.placement === 'on_site' ? 'success' : v.placement === 'remote' ? 'warning' : 'info', text: `Пришёл: ${pointName(v.pointId)} — ${PLACEMENT[v.placement].label.toLowerCase()}${extra}` })
    if (v.finishedAt) ev.push({ key: 'f' + v.id, at: v.finishedAt, type: 'info', text: `Ушёл: ${pointName(v.pointId)}` })
  }
  for (const o of repOrders.value) ev.push({ key: 'o' + o.id, at: o.at, type: 'primary', text: `Заказ ${o.number || ''} на ${fmtSum(o.sum)}${o.pointId ? ' — ' + pointName(o.pointId) : ''}` })
  return ev.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
})

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)
const progressColor = (p: number) => (p >= 80 ? '#67c23a' : p >= 50 ? '#e6a23c' : '#f56c6c')
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many
}

function syncQuery() {
  router.replace({ query: { ...(date.value !== kzToday() ? { date: date.value } : {}), ...(selectedId.value ? { repId: selectedId.value } : {}) } })
}
function select(id: string) { selectedId.value = id; syncQuery() }
function onSelect(id: string) { if (reps.value.some((r) => r.id === id)) select(id) }
function focusPoint(pid: string) {
  const p = pointsById.value.get(pid)
  if (p?.lat != null) mapRef.value?.focus(p.lat, p.lng, 17)
}
function setDate(d: string) { date.value = d; reload(true) }
function shift(days: number) { setDate(kzShift(date.value, days)) }

async function reload(syncUrl: boolean) {
  if (syncUrl) syncQuery()
  loading.value = true
  try {
    data.value = await api.get('/field/live', { params: { date: date.value } })
    updatedAt.value = kzTime(new Date())
  } catch (e) { showError(e) }
  loading.value = false
}

let timer: ReturnType<typeof setInterval> | null = null
watch([auto, isToday], () => {
  if (timer) { clearInterval(timer); timer = null }
  if (auto.value && isToday.value) timer = setInterval(() => { if (!document.hidden) reload(false) }, 60_000)
}, { immediate: true })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
onMounted(() => reload(false))
</script>

<style scoped>
.live { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 0; }
.bar h1 { margin: 0; }
.sub { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; min-height: 16px; }
.tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.kpi { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
.kpi.accent { background: linear-gradient(135deg, #0f766e, #2563eb); color: #fff; border: none; }
.kpi.accent .k-label, .kpi.accent .k-hint { color: rgba(255, 255, 255, .85); }
.k-label { font-size: 12px; color: var(--el-text-color-secondary); }
.k-value { font-size: 22px; font-weight: 700; line-height: 1.2; }
.k-value small { font-size: 13px; font-weight: 500; color: var(--el-text-color-secondary); }
.k-hint { font-size: 12px; color: var(--el-text-color-regular); min-height: 16px; }
.ok { color: #16a34a; } .warn { color: #d97706; } .bad { color: #dc2626; }

.body { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; height: calc(100vh - 290px); min-height: 520px; }
.map-wrap { position: relative; min-height: 0; }
.layers { position: absolute; top: 10px; right: 10px; z-index: 500; background: var(--el-bg-color); border-radius: 8px; padding: 4px 10px; box-shadow: 0 2px 8px rgba(0, 0, 0, .15); display: flex; gap: 10px; align-items: center; }
.legend { position: absolute; bottom: 22px; left: 10px; z-index: 500; background: var(--el-bg-color-overlay); border-radius: 8px; padding: 6px 10px; font-size: 12px; color: var(--el-text-color-regular); display: flex; gap: 12px; flex-wrap: wrap; box-shadow: 0 2px 8px rgba(0, 0, 0, .12); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .15); }

.side { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 12px; overflow-y: auto; min-height: 0; }
.side-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.rep-list { display: flex; flex-direction: column; gap: 8px; }
.rep { display: flex; gap: 10px; text-align: left; width: 100%; border: 1px solid var(--el-border-color-lighter); background: var(--el-bg-color); border-radius: 10px; padding: 10px; cursor: pointer; transition: border-color .15s, box-shadow .15s; font: inherit; color: inherit; }
.rep:hover { border-color: #99f6e4; box-shadow: 0 4px 14px rgba(15, 23, 42, .06); }
.avatar { width: 36px; height: 36px; border-radius: 50%; color: #fff; font-weight: 700; font-size: 13px; display: flex; align-items: center; justify-content: center; flex: none; }
.avatar.big { width: 46px; height: 46px; font-size: 16px; }
.rep-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.rep-top { display: flex; justify-content: space-between; gap: 6px; align-items: center; }
.rep-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rep-meta { font-size: 12px; color: var(--el-text-color-secondary); }
.rep-plan { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; font-size: 12px; color: var(--el-text-color-regular); }
.rep-stats { display: flex; gap: 10px; font-size: 12px; color: var(--el-text-color-regular); }
.rep-stats b { margin-left: auto; color: var(--el-text-color-primary); }

.who { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.who-name { font-size: 17px; font-weight: 700; }
.mini { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
.mini div { background: #f8fafc; border-radius: 8px; padding: 8px 4px; text-align: center; display: flex; flex-direction: column; }
.mini b { font-size: 14px; } .mini span { font-size: 11px; color: var(--el-text-color-secondary); }
.who-links { display: flex; gap: 14px; font-size: 13px; margin-bottom: 6px; }
.who-links a { color: #2563eb; text-decoration: none; }
h4 { margin: 14px 0 8px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.plan { list-style: none; padding: 0; margin: 0 0 6px; display: flex; flex-direction: column; gap: 4px; }
.plan li { display: grid; grid-template-columns: 24px 1fr; grid-template-rows: auto auto; column-gap: 8px; padding: 6px 8px; border-radius: 8px; background: #f8fafc; cursor: pointer; font-size: 13px; }
.plan li:hover { background: #eef2ff; }
.num { grid-row: span 2; width: 22px; height: 22px; border-radius: 50%; background: #409eff; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.plan li.done.on_site .num { background: #67c23a; }
.plan li.done.remote .num { background: #e6a23c; }
.plan li.done.unknown .num { background: #909399; }
.p-name { font-weight: 500; }
.p-state { font-size: 12px; color: var(--el-text-color-secondary); }

@media (max-width: 1100px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .body { grid-template-columns: 1fr; height: auto; }
  .map-wrap { height: 460px; }
}
</style>
