<template>
  <div>
    <PageHeader title="Корзина" subtitle="Документы, помеченные на удаление. Их можно открыть и восстановить — данные не теряются." />
    <el-card shadow="never">
      <div class="filters">
        <el-input v-model="search" placeholder="Номер, контрагент, комментарий" clearable style="width: 260px;" :prefix-icon="Search" @input="onSearch" @clear="load" />
        <el-select v-model="docType" clearable placeholder="Вид документа" style="width: 220px;" @change="load">
          <el-option v-for="(v, k) in TRADE_TYPES" :key="k" :label="v.ru" :value="k" />
        </el-select>
      </div>
      <el-table :data="items" size="small" v-loading="loading" :empty-text="error || 'Корзина пуста'" @row-click="(r: any) => router.push(`/accounting/trade/${r.id}`)" class="clickable">
        <el-table-column label="Вид" min-width="160"><template #default="{ row }">{{ TRADE_TYPES[row.docType]?.ru ?? row.docType }}</template></el-table-column>
        <el-table-column label="Номер" width="150" prop="number" />
        <el-table-column label="Дата" width="105"><template #default="{ row }">{{ fmtDate(row.date) }}</template></el-table-column>
        <el-table-column label="Контрагент" min-width="180"><template #default="{ row }">{{ row.counterparty?.name || '—' }}</template></el-table-column>
        <el-table-column label="Сумма" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.total) }}</template></el-table-column>
        <el-table-column label="Удалён" width="140"><template #default="{ row }">{{ fmtDateTime(row.updatedAt) }}</template></el-table-column>
        <el-table-column width="130" align="right">
          <template #default="{ row }">
            <el-button v-if="org.can('acc.doc.cancel')" size="small" :loading="busy === row.id" @click.stop="restore(row)">Восстановить</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">Восстановленный документ становится черновиком: проверьте его и проведите заново.</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtDateTime, fmtMoney } from '@/utils/format'
import { TRADE_TYPES, idem, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const items = ref<any[]>([])
const loading = ref(false)
const error = ref('')
const busy = ref('')
const search = ref('')
const docType = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = ((await api.get('/accounting/trade-documents', { params: { deleted: '1', search: search.value || undefined, docType: docType.value || undefined, limit: 200, sort: 'date_desc' } })) as any).items
  } catch (e: any) { error.value = e?.message || 'Не удалось загрузить' } finally { loading.value = false }
}
let timer: ReturnType<typeof setTimeout> | undefined
function onSearch() { clearTimeout(timer); timer = setTimeout(load, 350) }
async function restore(row: any) {
  busy.value = row.id
  try {
    await api.post(`/accounting/trade-documents/${row.id}/restore`, {}, idem())
    ElMessage.success(`${row.number} восстановлен (черновик)`)
    await load()
  } catch (e) { showError(e) } finally { busy.value = '' }
}
onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.clickable :deep(tr) { cursor: pointer; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 10px; }
</style>
