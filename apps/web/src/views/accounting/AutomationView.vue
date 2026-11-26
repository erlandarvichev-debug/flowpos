<template>
  <div>
    <PageHeader title="Сценарии" subtitle="Автоматика «если — то»: событие документа → задача сотруднику или смена этапа заказа">
      <el-button v-if="canManage" type="primary" :icon="Plus" @click="open()">Сценарий</el-button>
    </PageHeader>
    <el-card shadow="never">
      <el-table :data="rows" size="small" v-loading="loading" empty-text="Сценариев нет. Например: «Заказ от 100 000 ₸ → задача менеджеру позвонить клиенту»." class="clickable" @row-click="open">
        <el-table-column label="Сценарий" min-width="220"><template #default="{ row }"><b>{{ row.name }}</b><div v-if="row.lastError" class="bad small">Ошибка: {{ row.lastError }}</div></template></el-table-column>
        <el-table-column label="Если" min-width="260">
          <template #default="{ row }">{{ TRADE_TYPES[row.docType]?.ru }} {{ row.event === 'DOC_POSTED' ? 'проведён(а)' : 'создан(а)' }}<span v-if="row.condition?.minTotal" class="muted">, сумма от {{ fmtMoney(row.condition.minTotal) }} ₸</span></template>
        </el-table-column>
        <el-table-column label="То" min-width="260">
          <template #default="{ row }">{{ row.action === 'CREATE_TASK' ? `Задача: «${row.params.title}»` : `Этап заказа: ${ORDER_STATUS[row.params.stage]?.label}` }}</template>
        </el-table-column>
        <el-table-column label="Сработал" width="130" align="right"><template #default="{ row }">{{ row.runs }} раз<div v-if="row.lastRunAt" class="muted small">{{ fmtDateTime(row.lastRunAt) }}</div></template></el-table-column>
        <el-table-column label="" width="90"><template #default="{ row }"><el-tag size="small" :type="row.isActive ? 'success' : 'info'">{{ row.isActive ? 'включён' : 'выключен' }}</el-tag></template></el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="show" :title="form.id ? 'Сценарий' : 'Новый сценарий'" width="620px">
      <el-form label-width="140px">
        <el-form-item label="Название"><el-input v-model="form.name" placeholder="Например: Крупный заказ — позвонить" /></el-form-item>
        <el-form-item label="Когда">
          <div class="row">
            <el-select v-model="form.docType" style="width: 220px;"><el-option v-for="k in DOC_TYPES" :key="k" :label="TRADE_TYPES[k]?.ru" :value="k" /></el-select>
            <el-select v-model="form.event" style="width: 160px;"><el-option label="создан" value="DOC_CREATED" /><el-option label="проведён" value="DOC_POSTED" /></el-select>
          </div>
        </el-form-item>
        <el-form-item label="Сумма от"><el-input v-model="form.minTotal" placeholder="любая" style="width: 160px;" /></el-form-item>
        <el-form-item label="Что сделать">
          <el-radio-group v-model="form.action">
            <el-radio-button value="CREATE_TASK">Поставить задачу</el-radio-button>
            <el-radio-button value="SET_ORDER_STAGE" :disabled="!isOrderType(form.docType)">Сменить этап заказа</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.action === 'CREATE_TASK'">
          <el-form-item label="Текст задачи"><el-input v-model="form.title" placeholder="Позвонить {контрагент} по {номер}" /><div class="muted small">Можно вставлять: {номер}, {контрагент}, {сумма}</div></el-form-item>
          <el-form-item label="Кому">
            <el-select v-model="form.assignee" style="width: 260px;">
              <el-option label="Кто создал / провёл документ" value="AUTHOR" />
              <el-option label="Ответственный за заказ" value="RESPONSIBLE" />
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="Срок через"><el-input-number v-model="form.dueDays" :min="0" :max="365" style="width: 120px;" /> <span class="muted" style="margin-left: 8px;">дней</span></el-form-item>
        </template>
        <el-form-item v-else label="Этап">
          <el-select v-model="form.stage" style="width: 220px;"><el-option v-for="st in ORDER_STAGES[form.docType] ?? []" :key="st" :label="ORDER_STATUS[st].label" :value="st" /></el-select>
        </el-form-item>
        <el-form-item><el-checkbox v-model="form.isActive">Сценарий включён</el-checkbox></el-form-item>
      </el-form>
      <template #footer>
        <el-popconfirm v-if="form.id" title="Удалить сценарий?" @confirm="remove"><template #reference><el-button type="danger" link style="float: left;">Удалить</el-button></template></el-popconfirm>
        <el-button @click="show = false">Отмена</el-button>
        <el-button type="primary" :loading="busy" :disabled="!canManage" @click="save">Сохранить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useOrgStore } from '@/stores/org'
import { fmtDateTime, fmtMoney } from '@/utils/format'
import { ORDER_STAGES, ORDER_STATUS, isOrderType } from '@/utils/orders'
import { TRADE_TYPES, showError } from './acc'

const org = useOrgStore()
const canManage = computed(() => org.can('acc.refs.manage'))
const DOC_TYPES = ['CUSTOMER_ORDER', 'PURCHASE_ORDER', 'INVOICE_OUT', 'INVOICE_IN', 'DEMAND', 'SUPPLY', 'SALES_RETURN', 'PURCHASE_RETURN', 'MOVE', 'INTERNAL_ORDER', 'LOSS', 'ENTER', 'INVENTORY']
const rows = ref<any[]>([])
const users = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const show = ref(false)
const form = ref<any>({})

async function load() {
  loading.value = true
  try { rows.value = (await api.get('/accounting/automation')) as any } catch (e) { showError(e) } finally { loading.value = false }
}
function open(r?: any) {
  form.value = r?.id
    ? { id: r.id, name: r.name, docType: r.docType, event: r.event, minTotal: r.condition?.minTotal ?? '', action: r.action, title: r.params?.title ?? '', assignee: r.params?.assignee ?? 'AUTHOR', dueDays: r.params?.dueDays ?? 1, stage: r.params?.stage ?? 'CONFIRMED', isActive: r.isActive }
    : { name: '', docType: 'CUSTOMER_ORDER', event: 'DOC_CREATED', minTotal: '', action: 'CREATE_TASK', title: '', assignee: 'AUTHOR', dueDays: 1, stage: 'CONFIRMED', isActive: true }
  show.value = true
}
async function save() {
  const f = form.value
  const body = { name: f.name, docType: f.docType, event: f.event, isActive: f.isActive, condition: { minTotal: f.minTotal || undefined }, action: f.action, params: f.action === 'CREATE_TASK' ? { title: f.title, assignee: f.assignee, dueDays: f.dueDays } : { stage: f.stage } }
  busy.value = true
  try { if (f.id) await api.put(`/accounting/automation/${f.id}`, body); else await api.post('/accounting/automation', body); ElMessage.success('Сценарий сохранён'); show.value = false; load() } catch (e) { showError(e) } finally { busy.value = false }
}
async function remove() {
  try { await api.delete(`/accounting/automation/${form.value.id}`); show.value = false; load() } catch (e) { showError(e) }
}
onMounted(async () => { load(); try { users.value = (await api.get('/accounting/assignees')) as any } catch { users.value = [] } })
</script>

<style scoped>
.clickable :deep(tr) { cursor: pointer; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.muted { color: var(--fp-text-3); }
.small { font-size: 12px; }
.bad { color: var(--el-color-danger); }
</style>
