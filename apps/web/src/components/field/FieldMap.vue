<template>
  <!-- Карта OpenStreetMap (Leaflet): точки, отметки, линии пути; по щелчку — выбор места (pickable). -->
  <div ref="el" class="field-map" :style="{ height }" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export interface MapMarker {
  lat: number
  lng: number
  /** Цвет: green | orange | grey | blue | red или любой CSS-цвет (#2563eb). */
  color?: string
  /** Номер или короткая подпись внутри кружка. */
  label?: string
  /** Всплывающая подсказка (простой текст). */
  title?: string
  /** Радиус точки в метрах — рисуется окружностью. */
  radiusM?: number | null
  /** Для события select. */
  id?: string
  /** Вид: dot — маленькая точка без подписи, rep — торговый (крупнее, с обводкой и тенью). */
  kind?: 'pin' | 'dot' | 'rep'
  /** Мигающее кольцо вокруг (торговый сейчас на посещении). */
  pulse?: boolean
  /** Приглушить (выбран другой торговый). */
  faded?: boolean
}

export interface MapPath {
  points: Array<[number, number]>
  color?: string
  dashed?: boolean
  weight?: number
}

const props = withDefaults(defineProps<{
  markers?: MapMarker[]
  /** Одна линия пути (старый вариант). */
  path?: Array<[number, number]>
  /** Несколько линий своего цвета. */
  paths?: MapPath[]
  height?: string
  pickable?: boolean
  picked?: { lat: number; lng: number } | null
  /**
   * Подгонять масштаб под содержимое только при смене этого ключа. Без ключа — при каждом обновлении
   * (как раньше). Нужен живой карте: автообновление не должно сбрасывать масштаб, который выбрал человек.
   */
  fitKey?: string | number | null
}>(), { markers: () => [], path: () => [], paths: () => [], height: '520px', pickable: false, picked: null, fitKey: null })

const emit = defineEmits<{
  (e: 'pick', v: { lat: number; lng: number }): void
  (e: 'select', id: string): void
}>()

const COLORS: Record<string, string> = { green: '#67c23a', orange: '#e6a23c', grey: '#909399', blue: '#409eff', red: '#f56c6c' }
const el = ref<HTMLElement | null>(null)
let map: L.Map | null = null
let layer: L.LayerGroup | null = null
// Алматы — если показывать нечего.
const DEFAULT_CENTER: [number, number] = [43.238, 76.889]

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

// Цвет попадает в style="" — пропускаем только безопасные значения.
const safeColor = (c: string) => (/^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(c) ? c : COLORS.blue)

function icon(m: MapMarker) {
  const color = safeColor(COLORS[m.color || 'blue'] || m.color || COLORS.blue)
  const text = escapeHtml(String(m.label ?? ''))
  const kind = m.kind || 'pin'
  const size = kind === 'dot' ? 12 : kind === 'rep' ? 34 : 26
  return L.divIcon({
    className: `fm-icon fm-${kind}${m.pulse ? ' fm-pulse' : ''}${m.faded ? ' fm-faded' : ''}`,
    html: `<div style="background:${color};--c:${color}">${kind === 'dot' ? '' : text}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function draw(fit: boolean) {
  if (!map || !layer) return
  layer.clearLayers()
  const bounds: L.LatLngExpression[] = []
  const lines: MapPath[] = [...props.paths]
  if (props.path.length > 1) lines.push({ points: props.path, color: '#409eff', dashed: true })
  for (const ln of lines) {
    if (ln.points.length < 2) continue
    L.polyline(ln.points, { color: safeColor(ln.color || '#409eff'), weight: ln.weight ?? 3, opacity: 0.7, dashArray: ln.dashed ? '6 6' : undefined }).addTo(layer)
    bounds.push(...ln.points)
  }
  // Сначала мелкие точки, потом метки, торговые — сверху.
  const order = { dot: 0, pin: 1, rep: 2 } as const
  const markers = [...props.markers].sort((a, b) => order[a.kind || 'pin'] - order[b.kind || 'pin'])
  for (const m of markers) {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue
    if (m.radiusM) L.circle([m.lat, m.lng], { radius: m.radiusM, color: '#909399', weight: 1, fillOpacity: 0.05 }).addTo(layer)
    const mk = L.marker([m.lat, m.lng], { icon: icon(m), zIndexOffset: order[m.kind || 'pin'] * 1000 }).addTo(layer)
    if (m.title) mk.bindTooltip(escapeHtml(m.title).replace(/\n/g, '<br>'), { direction: 'top', offset: [0, -8] })
    if (m.id) mk.on('click', () => emit('select', m.id!))
    if (!m.faded) bounds.push([m.lat, m.lng])
  }
  if (props.picked) {
    L.marker([props.picked.lat, props.picked.lng], { icon: icon({ ...props.picked, color: 'red', label: '★' }) }).addTo(layer)
    bounds.push([props.picked.lat, props.picked.lng])
  }
  if (fit) {
    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds as any), { padding: [40, 40], maxZoom: 16 })
    else if (bounds.length === 1) map.setView(bounds[0] as any, 16)
  }
}

/** Показать всё содержимое карты (кнопка «Показать всех»). */
function fitAll() { draw(true) }
/** Приблизить к месту. */
function focus(lat: number, lng: number, zoom = 16) { map?.setView([lat, lng], zoom) }
defineExpose({ fitAll, focus })

let lastFitKey: unknown = undefined
onMounted(() => {
  if (!el.value) return
  map = L.map(el.value, { zoomControl: true }).setView(DEFAULT_CENTER, 12)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; участники OpenStreetMap',
  }).addTo(map)
  layer = L.layerGroup().addTo(map)
  map.on('click', (e: L.LeafletMouseEvent) => {
    if (props.pickable) emit('pick', { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) })
  })
  lastFitKey = props.fitKey
  draw(true)
  // Карта в диалоге или в сетке: размер известен только после показа.
  setTimeout(() => map?.invalidateSize(), 200)
})

watch(() => [props.markers, props.path, props.paths], () => {
  const fit = props.fitKey == null || props.fitKey !== lastFitKey
  lastFitKey = props.fitKey
  draw(fit)
}, { deep: true })
watch(() => props.picked, () => draw(false), { deep: true })
watch(() => props.height, () => setTimeout(() => map?.invalidateSize(), 50))

onBeforeUnmount(() => {
  map?.remove()
  map = null
})
</script>

<style scoped>
.field-map { width: 100%; border-radius: 8px; overflow: hidden; border: 1px solid var(--el-border-color-lighter); }
:deep(.fm-icon div) {
  width: 100%; height: 100%; border-radius: 50%; color: #fff; font-size: 12px; font-weight: 600; box-sizing: border-box;
  display: flex; align-items: center; justify-content: center; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
:deep(.fm-dot div) { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15); }
:deep(.fm-rep div) { position: relative; font-size: 13px; border-width: 3px; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35); cursor: pointer; }
:deep(.fm-faded) { opacity: 0.35; }
:deep(.fm-pulse div) { position: relative; }
:deep(.fm-pulse div::after) {
  content: ''; position: absolute; inset: -3px; border-radius: 50%; border: 3px solid var(--c);
  animation: fm-pulse 1.6s ease-out infinite;
}
@keyframes fm-pulse { from { transform: scale(1); opacity: 0.8; } to { transform: scale(1.9); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { :deep(.fm-pulse div::after) { animation: none; } }
</style>
