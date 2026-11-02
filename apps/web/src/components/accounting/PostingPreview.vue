<template>
  <!-- FP-029: «Проверить проведение» — эффект без записи (проводки, остатки, ошибки) и согласование версии. -->
  <el-button :loading="loading" @click="open">Проверить проведение</el-button>
  <el-dialog v-model="visible" title="Что произойдёт при проведении" width="min(860px, 96vw)" append-to-body>
    <template v-if="sim">
      <el-alert v-if="sim.error" type="error" :closable="false" show-icon :title="sim.error.message">
        <div v-if="sim.error.fix">{{ sim.error.fix }}</div>
      </el-alert>
      <el-alert v-else-if="sim.issue" type="warning" :closable="false" show-icon :title="sim.issue.message" />
      <el-alert v-else type="success" :closable="false" show-icon title="Документ проводится без ошибок. Ничего не записано — это проверка." />

      <h4>Проводки</h4>
      <el-table :data="postings" size="small" empty-text="Проводок нет">
        <el-table-column label="Дт" width="90"><template #default="{ row }">{{ row.side === 'D' ? row.account.code : '' }}</template></el-table-column>
        <el-table-column label="Кт" width="90"><template #default="{ row }">{{ row.side === 'C' ? row.account.code : '' }}</template></el-table-column>
        <el-table-column label="Счёт" min-width="220"><template #default="{ row }">{{ row.account.name }}<div v-if="row.memo" class="muted">{{ row.memo }}</div></template></el-table-column>
        <el-table-column label="Сумма" width="130" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
      </el-table>

      <template v-if="sim.stock?.length">
        <h4>Остатки</h4>
        <el-table :data="sim.stock" size="small">
          <el-table-column label="Склад / товар" min-width="200"><template #default="{ row }">{{ row.productId.slice(0, 8) }} · склад {{ row.storeId.slice(0, 8) }}</template></el-table-column>
          <el-table-column prop="before" label="Было" width="100" align="right" />
          <el-table-column label="Изменение" width="110" align="right"><template #default="{ row }"><b :class="Number(row.change) < 0 ? 'neg' : 'pos'">{{ Number(row.change) > 0 ? '+' : '' }}{{ row.change }}</b></template></el-table-column>
          <el-table-column prop="after" label="Станет" width="100" align="right" />
        </el-table>
      </template>

      <h4>Согласование</h4>
      <div v-if="!sim.approval.required" class="muted">Для этого документа согласование не требуется.</div>
      <template v-else>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="Требуется">при сумме от {{ fmtMoney(sim.approval.policy.minAmount) }}, действует {{ sim.approval.policy.ttlHours }} ч после решения</el-descriptions-item>
          <el-descriptions-item label="Состояние">
            <el-tag :type="sim.approval.satisfied ? 'success' : 'warning'" size="small">{{ sim.approval.satisfied ? 'согласовано — можно проводить' : approvalText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="Версия">{{ sim.approval.version }}</el-descriptions-item>
          <el-descriptions-item label="Хэш содержимого"><code>{{ sim.approval.hash.slice(0, 16) }}…</code></el-descriptions-item>
          <template v-if="a">
            <el-descriptions-item label="Сумма согласования">{{ fmtMoney(a.amount) }} {{ a.currency }}</el-descriptions-item>
            <el-descriptions-item label="Действует до">{{ a.expiresAt ? dt(a.expiresAt) : '—' }}</el-descriptions-item>
          </template>
        </el-descriptions>
        <div class="muted" style="margin-top: 6px;">Согласование относится к этой версии и сумме. Любое изменение документа его отменяет; использовать можно один раз.</div>
        <div class="actions">
          <el-button v-if="!a || a.status !== 'PENDING' && !sim.approval.satisfied" type="primary" :loading="busy" @click="request">Запросить согласование</el-button>
          <template v-if="a?.status === 'PENDING' && org.can('acc.doc.approve') && a.requestedBy !== auth.user?.id">
            <el-button type="success" :loading="busy" @click="decide('APPROVE')">Согласовать</el-button>
            <el-button type="danger" plain :loading="busy" @click="decide('REJECT')">Отклонить</el-button>
          </template>
          <span v-if="a?.status === 'PENDING' && (!org.can('acc.doc.approve') || a.requestedBy === auth.user?.id)" class="muted">Ждёт решения: согласует другой сотрудник с правом согласования.</span>
        </div>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useAuthStore } from '@/stores/auth'
import { fmtMoney, idem, showError } from '@/views/accounting/acc'

const props = defineProps<{ kind: 'TRADE' | 'ACC'; id: string; version: number }>()
const emit = defineEmits<{ (e: 'changed'): void }>()
const org = useOrgStore()
const auth = useAuthStore()
const visible = ref(false)
const loading = ref(false)
const busy = ref(false)
const sim = ref<any>(null)
const a = computed(() => sim.value?.approval?.approval ?? null)
const postings = computed(() => [...(sim.value?.entry?.postings ?? []), ...(sim.value?.costEntries ?? []).flatMap((e: any) => e.postings)])
const dt = (v: string) => new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
const STATUS: Record<string, string> = { PENDING: 'ждёт решения', APPROVED: 'согласовано', REJECTED: 'отклонено', SUPERSEDED: 'отменено изменением', CONSUMED: 'использовано' }
const approvalText = computed(() => (a.value ? `${STATUS[a.value.status] ?? a.value.status}${a.value.status === 'APPROVED' ? ' (другая версия или срок истёк)' : ''}` : 'не запрошено'))

async function load() {
  sim.value = await api.post(`/accounting/${props.kind === 'TRADE' ? 'trade-documents' : 'documents'}/${props.id}/simulate`, {})
}
async function open() {
  loading.value = true
  try {
    await load()
    visible.value = true
  } catch (e) { showError(e) }
  loading.value = false
}
async function request() {
  busy.value = true
  try {
    await api.post('/accounting/approvals', { docKind: props.kind, docId: props.id, expectedVersion: props.version }, idem())
    ElMessage.success('Согласование запрошено')
    await load()
    emit('changed')
  } catch (e) { showError(e) }
  busy.value = false
}
async function decide(decision: 'APPROVE' | 'REJECT') {
  let note: string | undefined
  if (decision === 'REJECT') {
    try {
      note = (await ElMessageBox.prompt('Причина отказа', 'Отклонить', { confirmButtonText: 'Отклонить', cancelButtonText: 'Отмена', inputValidator: (v: string) => (String(v ?? '').trim().length >= 5 ? true : 'Не короче 5 символов') })).value
    } catch { return }
  }
  busy.value = true
  try {
    await api.post(`/accounting/approvals/${a.value.id}/decide`, { decision, note }, idem())
    ElMessage.success(decision === 'APPROVE' ? 'Согласовано' : 'Отклонено')
    await load()
    emit('changed')
  } catch (e) { showError(e) }
  busy.value = false
}
</script>

<style scoped>
h4 { margin: 16px 0 8px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.neg { color: var(--el-color-danger); }
.pos { color: var(--el-color-success); }
</style>
