<template>
  <!-- «Супервайзер»: посещения за день — где был представитель, на точке или удалённо, фото, заказы, задания. -->
  <div>
    <div class="page-header"><h1>Посещения</h1></div>
    <el-card>
      <div class="filters">
        <el-date-picker v-model="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" @change="load" />
        <el-select v-model="repId" clearable placeholder="Все представители" filterable style="width: 220px;" @change="load">
          <el-option v-for="r in reps" :key="r.id" :value="r.id" :label="r.name" />
        </el-select>
        <span class="muted">Посещений: {{ visits.length }} · на точке {{ count('on_site') }} · удалённо {{ count('remote') }} · не определено {{ count('unknown') }}</span>
      </div>
      <el-empty v-if="!loading && !visits.length" description="Посещений за этот день нет" />
      <div v-loading="loading">
        <div v-for="v in visits" :key="v.id" class="visit">
          <div class="head">
            <b>{{ kzTime(v.startedAt) }}<template v-if="v.finishedAt">–{{ kzTime(v.finishedAt) }}</template></b>
            <span>{{ v.point?.name ?? '—' }}</span>
            <el-tag :type="PLACEMENT[v.placement]?.tag" size="small">{{ PLACEMENT[v.placement]?.label }}</el-tag>
            <span class="muted">{{ v.rep?.name }}<template v-if="v.distanceM != null"> · до точки {{ fmtDistance(v.distanceM) }}</template><template v-if="v.accuracyM != null"> · точность {{ fmtDistance(v.accuracyM) }}</template> · {{ fmtDuration(v.startedAt, v.finishedAt) }}</span>
          </div>
          <div v-if="v.point?.address" class="muted">{{ v.point.address }}</div>
          <div v-if="v.comment" class="comment">{{ v.comment }}</div>
          <div v-if="v.tasks.length" class="line">Задания: <span v-for="t in v.tasks" :key="t.id" class="chip">✓ {{ t.title }}<template v-if="t.result"> — {{ t.result }}</template></span></div>
          <div v-if="v.orders.length" class="line">Заказы: <span v-for="o in v.orders" :key="o.id" class="chip">{{ o.number || 'заказ' }} · {{ fmtSum(o.sum) }}</span></div>
          <div v-if="v.photos.length" class="photos">
            <el-image v-for="p in v.photos" :key="p.id" :src="urls[p.id]" :preview-src-list="v.photos.map((x: any) => urls[x.id]).filter(Boolean)" fit="cover" class="thumb" :preview-teleported="true">
              <template #placeholder><div class="ph">…</div></template>
              <template #error><div class="ph">фото</div></template>
            </el-image>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { PLACEMENT, fmtDistance, fmtDuration, fmtSum, kzTime, kzToday, loadReps, photoUrl, type Rep } from './field'

// С карты торговых приходят ?date= и ?repId=.
const route = useRoute()
const reps = ref<Rep[]>([])
const repId = ref(String(route.query.repId || ''))
const date = ref(/^\d{4}-\d{2}-\d{2}$/.test(String(route.query.date)) ? String(route.query.date) : kzToday())
const visits = ref<any[]>([])
const loading = ref(false)
const urls = reactive<Record<string, string>>({})

const count = (p: string) => visits.value.filter((v) => v.placement === p).length

async function load() {
  loading.value = true
  try {
    visits.value = (await api.get('/field/visits', { params: { date: date.value, repId: repId.value || undefined } })) as any
    for (const v of visits.value) for (const p of v.photos) {
      if (!urls[p.id]) photoUrl(p.id).then((u) => { urls[p.id] = u }).catch(() => undefined)
    }
  } catch (e) { showError(e) }
  loading.value = false
}

onMounted(async () => {
  try { reps.value = await loadReps() } catch (e) { showError(e) }
  await load()
})
</script>

<style scoped>
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.visit { border-bottom: 1px solid var(--el-border-color-lighter); padding: 12px 0; }
.head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.comment { margin-top: 6px; white-space: pre-wrap; }
.line { margin-top: 6px; font-size: 13px; }
.chip { display: inline-block; background: var(--el-fill-color-light); border-radius: 4px; padding: 1px 8px; margin: 2px 4px 2px 0; }
.photos { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.thumb { width: 96px; height: 96px; border-radius: 6px; }
.ph { width: 96px; height: 96px; display: flex; align-items: center; justify-content: center; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); }
</style>
