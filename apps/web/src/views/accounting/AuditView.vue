<template>
  <div>
    <PageHeader title="Журнал действий" subtitle="Кто, что и когда сделал в организации: документы, справочники, настройки" />
    <el-card shadow="never">
      <div class="filters">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" unlink-panels start-placeholder="с" end-placeholder="по" style="width: 250px;" @change="load" />
        <el-select v-model="userId" clearable filterable placeholder="Сотрудник" style="width: 200px;" @change="load">
          <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
        </el-select>
        <el-input v-model="action" placeholder="Действие (например, DELETE)" clearable style="width: 220px;" @change="load" @clear="load" />
      </div>
      <el-table :data="rows" size="small" v-loading="loading" :empty-text="error || 'Записей нет'">
        <el-table-column label="Когда" width="140"><template #default="{ row }">{{ fmtDateTime(row.ts) }}</template></el-table-column>
        <el-table-column label="Кто" width="170"><template #default="{ row }">{{ row.userName || '—' }}</template></el-table-column>
        <el-table-column label="Действие" min-width="200"><template #default="{ row }">{{ label(row.action) }}<div class="muted small">{{ row.action }}</div></template></el-table-column>
        <el-table-column label="Объект" min-width="160">
          <template #default="{ row }">
            <el-link v-if="row.entity === 'document' && row.entityId" type="primary" @click="router.push(`/accounting/trade/${row.entityId}`)">Документ</el-link>
            <span v-else>{{ row.entity }}</span>
          </template>
        </el-table-column>
        <el-table-column label="Подробности" min-width="260">
          <template #default="{ row }"><span class="muted small">{{ row.reason ? `Причина: ${row.reason}. ` : '' }}{{ brief(row) }}</span></template>
        </el-table-column>
      </el-table>
      <div class="hint">Показаны последние 500 записей по фильтру. Записи журнала не меняются и не удаляются.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { fmtDateTime, kzToday, shiftDay } from '@/utils/format'

const router = useRouter()
const LABELS: Record<string, string> = {
  TRADE_DOC_CREATE: 'Создан документ', TRADE_DOC_UPDATE: 'Изменён документ', TRADE_DOC_RESTORE: 'Восстановлен документ', TRADE_DOC_DUE_DATE: 'Изменён срок оплаты',
  ORDER_CLOSE: 'Закрыт заказ', ORDER_INFO: 'Этап / дата / ответственный заказа', STOCK_RESERVE: 'Резерв товара', STOCK_RESERVE_RELEASE: 'Снят резерв',
  CONTRACT_CREATED: 'Создан договор', CONTRACT_UPDATED: 'Изменён договор', ORG_CREATE: 'Создана организация',
}
const label = (a: string) => LABELS[a] ?? a.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
function brief(r: any) {
  const after = r.after && typeof r.after === 'object' ? r.after : null
  if (!after) return ''
  return Object.entries(after).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(', ')
}
const range = ref<[string, string] | null>([shiftDay(kzToday(), -6), kzToday()])
const userId = ref('')
const action = ref('')
const rows = ref<any[]>([])
const users = ref<any[]>([])
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    rows.value = (await api.get('/accounting/audit', { params: { from: range.value?.[0], to: range.value?.[1], userId: userId.value || undefined, action: action.value || undefined, limit: 500 } })) as any
  } catch (e: any) { error.value = e?.message || 'Нет доступа к журналу' } finally { loading.value = false }
}
onMounted(async () => {
  load()
  try { users.value = (await api.get('/accounting/assignees')) as any } catch { users.value = [] }
})
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.muted { color: var(--el-text-color-secondary); }
.small { font-size: 11px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 10px; }
</style>
