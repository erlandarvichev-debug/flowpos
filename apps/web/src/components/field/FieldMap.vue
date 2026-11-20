<template>
  <!-- Карта OpenStreetMap (Leaflet): точки, отметки, линия пути; по щелчку — выбор места (pickable). -->
  <div ref="el" class="field-map" :style="{ height }" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export interface MapMarker {
  lat: number
  lng: number
  /** Цвет кружка: green | orange | grey | blue | red */
  color?: string
  /** Номер или короткая подпись внутри кружка. */
  label?: string
  /** Всплывающая подсказка (простой текст). */
  title?: string
  /** Радиус точки в метрах — рисуется окружностью. */
  radiusM?: number | null
}

const props = withDefaults(defineProps<{
  markers?: MapMarker[]
  path?: Array<[number, number]>
  height?: string
  pickable?: boolean
  picked?: { lat: number; lng: number } | null
}>(), { markers: () => [], path: () => [], height: '520px', pickable: false, picked: null })

const emit = defineEmits<{ (e: 'pick', v: { lat: number; lng: number }): void }>()

const COLORS: Record<string, string> = { green: '#67c23a', orange: '#e6a23c', grey: '#909399', blue: '#409eff', red: '#f56c6c' }
const el = ref<HTMLElement | null>(null)
let map: L.Map | null = null
let layer: L.LayerGroup | null = null
// Алматы — если показывать нечего.
const DEFAULT_CENTER: [number, number] = [43.238, 76.889]

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function icon(m: MapMarker) {
  const color = COLORS[m.color || 'blue'] || m.color || COLORS.blue
  const text = escapeHtml(String(m.label ?? ''))
  return L.divIcon({
    className: 'fm-icon',
    html: `<div style="background:${color}">${text}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}

function draw(fit: boolean) {
  if (!map || !layer) return
  layer.clearLayers()
  const bounds: L.LatLngExpression[] = []
  if (props.path.length > 1) {
    L.polyline(props.path, { color: '#409eff', weight: 3, opacity: 0.6, dashArray: '6 6' }).addTo(layer)
    bounds.push(...props.path)
  }
  for (const m of props.markers) {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue
    if (m.radiusM) L.circle([m.lat, m.lng], { radius: m.radiusM, color: '#909399', weight: 1, fillOpacity: 0.05 }).addTo(layer)
    const mk = L.marker([m.lat, m.lng], { icon: icon(m) }).addTo(layer)
    if (m.title) mk.bindTooltip(escapeHtml(m.title).replace(/\n/g, '<br>'))
    bounds.push([m.lat, m.lng])
  }
  if (props.picked) {
    L.marker([props.picked.lat, props.picked.lng], { icon: icon({ ...props.picked, color: 'red', label: '★' }) }).addTo(layer)
    bounds.push([props.picked.lat, props.picked.lng])
  }
  if (fit) {
    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds as any), { padding: [30, 30], maxZoom: 16 })
    else if (bounds.length === 1) map.setView(bounds[0] as any, 16)
  }
}

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
  draw(true)
  // Карта в диалоге: размер известен только после показа.
  setTimeout(() => map?.invalidateSize(), 200)
})

watch(() => [props.markers, props.path], () => draw(true), { deep: true })
watch(() => props.picked, () => draw(false), { deep: true })

onBeforeUnmount(() => {
  map?.remove()
  map = null
})
</script>

<style scoped>
.field-map { width: 100%; border-radius: 8px; overflow: hidden; border: 1px solid #ebeef5; }
:deep(.fm-icon div) {
  width: 26px; height: 26px; border-radius: 50%; color: #fff; font-size: 12px; font-weight: 600;
  display: flex; align-items: center; justify-content: center; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
</style>
