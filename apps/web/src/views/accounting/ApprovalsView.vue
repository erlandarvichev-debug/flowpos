<template>
  <!-- FP-029: согласования проведения — ожидающие решения, история и правила организации. -->
  <div>
    <div class="page-header"><h1>Согласования</h1></div>
    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;"
      title="Согласование относится к конкретной версии документа и сумме, действует ограниченное время и используется один раз. Любое изменение документа его отменяет. Согласует не тот, кто запросил." />
    <el-tabs v-model="tab" @tab-change="load">
      <el-tab-pane label="Ждут решения" name="PENDING" />
      <el-tab-pane label="Все" name="ALL" />
      <el-tab-pane label="Правила" name="POLICIES" />
    </el-tabs>

    <el-table v-if="tab !== 'POLICIES'" v-loading="loading" :data="items" size="small" :empty-text="tab === 'PENDING' ? 'Нечего согласовывать' : 'Согласований нет'">
      <el-table-column label="Документ" min-width="200">
        <template #default="{ row }">
          <el-link type="primary" @click="openDoc(row)">{{ row.docNumber ?? row.docId.slice(0, 8) }}</el-link>
          <div class="muted">{{ row.docKind === 'TRADE' ? 'торговый' : 'учёта' }} · {{ row.docType }} · версия {{ row.docVersion }}</div>
        </template>
      </el-table-column>
      <el-table-column label="Сумма" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }} {{ row.currency }}</template></el-table-column>
      <el-table-column label="Запрошено" width="150"><template #default="{ row }">{{ dt(row.createdAt) }}<div v-if="row.requestNote" class="muted">{{ row.requestNote }}</div></template></el-table-column>
      <el-table-column label="Состояние" width="200">
        <template #default="{ row }">
          <el-tag :type="TAG[row.status]" size="small">{{ STATUS[row.status] ?? row.status }}</el-tag>
          <div v-if="row.expiresAt && row.status === 'APPROVED'" class="muted">до {{ dt(row.expiresAt) }}</div>
          <div v-if="row.decisionNote" class="muted">{{ row.decisionNote }}</div>
        </template>
      </el-table-column>
      <el-table-column label="" width="190">
        <template #default="{ row }">
          <span v-if="row.status === 'PENDING' && row.requestedBy === auth.user?.id" class="muted">ваш запрос — согласует другой</span>
          <template v-else-if="row.status === 'PENDING' && org.can('acc.doc.approve')">
            <el-button link type="success" size="small" @click="decide(row, 'APPROVE')">Согласовать</el-button>
            <el-button link type="danger" size="small" @click="decide(row, 'REJECT')">Отклонить</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <template v-else>
      <div class="bar"><el-button v-if="org.can('acc.policy.manage')" type="primary" @click="openPolicy()">Новое правило</el-button></div>
      <el-table :data="policies" size="small" empty-text="Правил нет — согласование не требуется">
        <el-table-column label="Документы" min-width="200"><template #default="{ row }">{{ row.docKind === 'TRADE' ? 'Торговые' : 'Учёта' }} · {{ row.docType === '*' ? 'все виды' : row.docType }}</template></el-table-column>
        <el-table-column label="Сумма от" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.minAmount) }}</template></el-table-column>
        <el-table-column label="Действует" width="140"><template #default="{ row }">{{ row.ttlHours }} ч после решения</template></el-table-column>
        <el-table-column label="Статус" width="160">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? 'включено' : 'выключено' }}</el-tag>
            <el-button v-if="org.can('acc.policy.manage')" link type="primary" size="small" @click="openPolicy(row)">Изменить</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-dialog v-model="policyOpen" :title="pf.id ? 'Правило согласования' : 'Новое правило согласования'" width="520px">
      <el-form label-width="170px">
        <el-form-item label="Документы">
          <el-radio-group v-model="pf.docKind" :disabled="!!pf.id"><el-radio-button value="TRADE">торговые</el-radio-button><el-radio-button value="ACC">учёта</el-radio-button></el-radio-group>
        </el-form-item>
        <el-form-item label="Вид документа"><el-input v-model="pf.docType" placeholder="* — все виды (или SUPPLY, BANK_OUT…)" /></el-form-item>
        <el-form-item label="Сумма от, ₸"><el-input v-model="pf.minAmount" style="width: 160px;" /></el-form-item>
        <el-form-item label="Действует после решения, ч"><el-input-number v-model="pf.ttlHours" :min="1" :max="168" /></el-form-item>
        <el-form-item v-if="pf.id"><el-checkbox v-model="pf.enabled">Включено</el-checkbox></el-form-item>
      </el-form>
      <template #footer><el-button @click="policyOpen = false">Отмена</el-button><el-button type="primary" :loading="busy" @click="savePolicy">Сохранить</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useAuthStore } from '@/stores/auth'
import { fmtMoney, idem, showError } from './acc'

const router = useRouter()
const org = useOrgStore()
const auth = useAuthStore()
const tab = ref('PENDING')
const loading = ref(false)
const busy = ref(false)
const items = ref<any[]>([])
const policies = ref<any[]>([])
const STATUS: Record<string, string> = { PENDING: 'ждёт решения', APPROVED: 'согласовано', REJECTED: 'отклонено', SUPERSEDED: 'отменено изменением', CONSUMED: 'использовано' }
const TAG: Record<string, 'warning' | 'success' | 'danger' | 'info'> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', SUPERSEDED: 'info', CONSUMED: 'info' }
const dt = (v: string) => new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })

async function load() {
  loading.value = true
  try {
    if (tab.value === 'POLICIES') policies.value = (await api.get('/accounting/approval-policies')) as any
    else items.value = (await api.get('/accounting/approvals', { params: tab.value === 'PENDING' ? { status: 'PENDING' } : {} })) as any
  } catch (e) { showError(e) }
  loading.value = false
}

const openDoc = (row: any) => router.push(row.docKind === 'TRADE' ? `/accounting/trade/${row.docId}` : `/accounting/documents/${row.docId}`)

async function decide(row: any, decision: 'APPROVE' | 'REJECT') {
  let note: string | undefined
  if (decision === 'REJECT') {
    try {
      note = (await ElMessageBox.prompt('Причина отказа', 'Отклонить', { confirmButtonText: 'Отклонить', cancelButtonText: 'Отмена', inputValidator: (v: string) => (String(v ?? '').trim().length >= 5 ? true : 'Не короче 5 символов') })).value
    } catch { return }
  }
  try {
    await api.post(`/accounting/approvals/${row.id}/decide`, { decision, note }, idem())
    ElMessage.success(decision === 'APPROVE' ? 'Согласовано' : 'Отклонено')
    load()
  } catch (e) { showError(e) }
}

const policyOpen = ref(false)
const pf = ref<any>({})
function openPolicy(p?: any) {
  pf.value = p ? { id: p.id, docKind: p.docKind, docType: p.docType, minAmount: String(Number(p.minAmount)), ttlHours: p.ttlHours, enabled: p.enabled } : { docKind: 'TRADE', docType: '*', minAmount: '0', ttlHours: 24 }
  policyOpen.value = true
}
async function savePolicy() {
  busy.value = true
  try {
    const { id, ...b } = pf.value
    await (id ? api.put(`/accounting/approval-policies/${id}`, b) : api.post('/accounting/approval-policies', b))
    ElMessage.success('Правило сохранено')
    policyOpen.value = false
    load()
  } catch (e) { showError(e) }
  busy.value = false
}

onMounted(load)
</script>

<style scoped>
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.bar { margin-bottom: 10px; }
</style>
