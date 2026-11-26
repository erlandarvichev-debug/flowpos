<template>
  <div>
    <PageHeader title="Договоры" subtitle="Все договоры с покупателями и поставщиками: сроки, отсрочка, документы" />
    <el-card shadow="never">
      <div class="filters">
        <el-input v-model="search" placeholder="Номер, название, контрагент" clearable style="width: 280px;" :prefix-icon="Search" @input="onSearch" @clear="load" />
        <el-radio-group v-model="active" @change="load">
          <el-radio-button value="1">Действующие</el-radio-button>
          <el-radio-button value="0">Закрытые</el-radio-button>
          <el-radio-button value="">Все</el-radio-button>
        </el-radio-group>
      </div>
      <el-table :data="rows" size="small" v-loading="loading" :empty-text="error || 'Договоров нет. Договор добавляется в карточке контрагента.'" class="clickable" @row-click="(r: any) => router.push(`/catalog/counterparties/${r.counterpartyId}`)">
        <el-table-column label="Договор" min-width="200">
          <template #default="{ row }"><b>№ {{ row.number }}</b><span v-if="row.date" class="muted"> от {{ fmtDate(row.date) }}</span><div v-if="row.name" class="muted small">{{ row.name }}</div></template>
        </el-table-column>
        <el-table-column label="Контрагент" min-width="200"><template #default="{ row }">{{ row.counterparty?.name }}<div class="muted small">{{ row.counterparty?.inn }}</div></template></el-table-column>
        <el-table-column label="Вид" width="110"><template #default="{ row }">{{ TYPE[row.type] ?? '—' }}</template></el-table-column>
        <el-table-column label="Действует" width="190">
          <template #default="{ row }">
            {{ row.startDate ? fmtDate(row.startDate) : '…' }} — {{ row.endDate ? fmtDate(row.endDate) : 'бессрочно' }}
            <el-tag v-if="row.isActive && row.endDate && expiresSoon(row.endDate)" size="small" type="warning" effect="plain">{{ expired(row.endDate) ? 'истёк' : 'истекает' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Отсрочка" width="95" align="right"><template #default="{ row }">{{ row.paymentDays != null ? `${row.paymentDays} дн.` : '—' }}</template></el-table-column>
        <el-table-column label="Валюта" width="75" prop="currency" />
        <el-table-column label="Документы" width="120" align="right"><template #default="{ row }">{{ row.documents || '—' }}<div v-if="row.lastDocDate" class="muted small">посл. {{ fmtDate(row.lastDocDate) }}</div></template></el-table-column>
        <el-table-column label="Статус" width="105"><template #default="{ row }"><el-tag size="small" :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? 'действует' : 'закрыт' }}</el-tag></template></el-table-column>
      </el-table>
      <div class="hint">Договор создаётся и меняется в карточке контрагента. Отмечены договоры, срок которых истёк или истекает в ближайшие 30 дней.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { fmtDate } from '@/utils/format'

const router = useRouter()
const TYPE: Record<string, string> = { SALE: 'с покупателем', PURCHASE: 'с поставщиком', COMMISSION: 'комиссия', OTHER: 'прочий' }
const rows = ref<any[]>([])
const loading = ref(false)
const error = ref('')
const search = ref('')
const active = ref('1')
const expiresSoon = (d: string) => new Date(d).getTime() < Date.now() + 30 * 86400e3
const expired = (d: string) => new Date(d).getTime() < Date.now()
async function load() {
  loading.value = true
  error.value = ''
  try { rows.value = (await api.get('/accounting/contracts/registry', { params: { search: search.value || undefined, active: active.value || undefined } })) as any } catch (e: any) { error.value = e?.message || 'Не удалось загрузить' } finally { loading.value = false }
}
let timer: ReturnType<typeof setTimeout> | undefined
function onSearch() { clearTimeout(timer); timer = setTimeout(load, 350) }
onMounted(load)
</script>

<style scoped>
.clickable :deep(tr) { cursor: pointer; }
.muted { color: var(--fp-text-3); }
.small { font-size: 12px; }
.hint { color: var(--fp-text-3); font-size: 12px; margin-top: 10px; }
</style>
