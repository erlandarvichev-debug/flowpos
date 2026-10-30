<template>
  <!-- FP-020: карточка ЭСФ — реквизиты, строки, исходный XML, форма и хэш, цепочка, решения, НДС, история. -->
  <el-drawer :model-value="!!id" size="72%" :title="card ? `ЭСФ № ${card.num}` : 'ЭСФ'" @update:model-value="(v: boolean) => !v && emit('close')">
    <div v-loading="loading">
      <template v-if="card">
        <el-alert v-if="card.status === 'UNKNOWN' && card.unknown" :type="card.unknown.canRelease ? 'success' : 'warning'" :closable="false" show-icon style="margin-bottom: 12px;" title="Результат отправки неизвестен">
          <p style="margin: 4px 0 8px;">{{ card.unknown.message }}</p>
          <p style="margin: 0 0 8px;">Повторная отправка без сверки может создать дубль: сначала сверьте статус.</p>
          <el-button size="small" type="primary" :loading="busy" @click="emit('reconcile')">Сверить статус</el-button>
          <el-button v-if="card.unknown.canRelease && canSend" size="small" @click="emit('release', card)">Разрешить повторную отправку</el-button>
        </el-alert>

        <el-tabs v-model="section">
          <el-tab-pane label="Реквизиты" name="main">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="Направление">{{ card.direction === 'INBOUND' ? 'Входящий' : 'Исходящий' }}</el-descriptions-item>
              <el-descriptions-item label="Вид">{{ TYPE_FULL[card.invoiceType] ?? card.invoiceType }}</el-descriptions-item>
              <el-descriptions-item label="Дата выписки">{{ fmtDate(card.date) }}</el-descriptions-item>
              <el-descriptions-item label="Дата оборота">{{ fmtDate(card.turnoverDate) }}</el-descriptions-item>
              <el-descriptions-item label="Поставщик">{{ card.sellerName }} <span class="muted">{{ card.sellerTin }}</span></el-descriptions-item>
              <el-descriptions-item label="Получатель">{{ card.customerName }} <span class="muted">{{ card.customerTin }}</span></el-descriptions-item>
              <el-descriptions-item label="Без НДС">{{ fmtMoney(card.totalWithoutTax) }}</el-descriptions-item>
              <el-descriptions-item label="НДС">{{ fmtMoney(card.totalNds) }}</el-descriptions-item>
              <el-descriptions-item label="Всего">{{ fmtMoney(card.totalWithTax) }}</el-descriptions-item>
              <el-descriptions-item label="Рег. номер"><span class="mono">{{ card.registrationNumber || '—' }}</span></el-descriptions-item>
              <el-descriptions-item label="Статус FlowPOS">{{ statusText(card.status) }}</el-descriptions-item>
              <el-descriptions-item label="Статус ИС ЭСФ">{{ statusText(card.esfStatus) }}</el-descriptions-item>
              <el-descriptions-item label="Получение (техн.)">{{ card.deliveryConfirmedAt ? fmtDate(card.deliveryConfirmedAt) : '—' }}</el-descriptions-item>
              <el-descriptions-item label="Решение">{{ DECIDED[card.businessDecision] ?? 'нет решения' }}</el-descriptions-item>
              <el-descriptions-item v-if="card.cancelReason" label="Причина" :span="2">{{ card.cancelReason }}</el-descriptions-item>
            </el-descriptions>
            <div v-if="card.errors?.length" class="errors" role="alert">
              <div v-for="(e, i) in card.errors" :key="i">• {{ e.text || e.errorCode }} <span class="muted" v-if="e.property">({{ e.property }})</span> <span class="mono muted">{{ e.errorCode }}</span></div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="Строки" name="lines">
            <el-alert v-if="card.parseError" type="error" :closable="false" :title="card.parseError">
              Исходный XML сохранён без изменений — см. вкладку «Исходный XML».
              <div v-if="card.parseErrorDetail" class="muted">Техническая причина: {{ card.parseErrorDetail }}</div>
            </el-alert>
            <el-table v-else :data="card.parsed?.products ?? []" size="small" empty-text="Строк нет" aria-label="Строки ЭСФ">
              <el-table-column type="index" width="44" label="№" />
              <el-table-column prop="description" label="Наименование" min-width="220" />
              <el-table-column label="Кол-во" width="140" align="right"><template #default="{ row }">{{ row.quantity ?? '—' }} <span class="muted" :title="row.unitNomenclature ? `Код единицы ИС ЭСФ: ${row.unitNomenclature}` : undefined">{{ row.unitName ?? (row.unitNomenclature ? `ед. ${row.unitNomenclature}` : '') }}</span></template></el-table-column>
              <el-table-column label="Без НДС" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.priceWithoutTax) }}</template></el-table-column>
              <el-table-column label="НДС" width="110" align="right"><template #default="{ row }">{{ fmtMoney(row.ndsAmount) }}</template></el-table-column>
              <el-table-column label="Всего" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.priceWithTax) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="Исходный XML" name="raw">
            <p class="muted">Форма: {{ card.formVersion || 'не определена' }} · SHA-256: <span class="mono">{{ card.bodyHash }}</span></p>
            <el-button size="small" @click="copy">Копировать XML</el-button>
            <pre class="xml" tabindex="0" aria-label="Исходный XML ЭСФ">{{ card.body }}</pre>
          </el-tab-pane>

          <el-tab-pane label="Цепочка" name="chain">
            <p v-if="!card.chain.original && !card.chain.corrections.length" class="muted">Исправлений и дополнений нет.</p>
            <div v-if="card.chain.original"><b>Исходный:</b> <el-button link type="primary" @click="emit('open', card.chain.original.id)">№ {{ card.chain.original.num }} от {{ fmtDate(card.chain.original.date) }}</el-button> <span class="muted">{{ statusText(card.chain.original.esfStatus || card.chain.original.status) }}</span></div>
            <div v-for="c in card.chain.corrections" :key="c.id"><b>{{ TYPE_FULL[c.invoiceType] }}:</b> <el-button link type="primary" @click="emit('open', c.id)">№ {{ c.num }} от {{ fmtDate(c.date) }}</el-button> <span class="muted">{{ statusText(c.esfStatus || c.status) }} · {{ fmtMoney(c.totalWithTax) }}</span></div>
          </el-tab-pane>

          <el-tab-pane :label="`Решения (${card.decisions.length})`" name="decisions">
            <el-table :data="card.decisions" size="small" empty-text="Решений нет" aria-label="Решения по ЭСФ">
              <el-table-column label="Решение" width="170"><template #default="{ row }">{{ KIND_TEXT[row.kind] ?? row.kind }}</template></el-table-column>
              <el-table-column prop="basis" label="Основание" min-width="200" />
              <el-table-column prop="status" label="Статус" width="120" />
              <el-table-column label="Предложено" width="150"><template #default="{ row }">{{ fmtDateTime(row.proposedAt) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane v-if="card.vat" label="НДС к зачёту" name="vat">
            <el-descriptions :column="3" border size="small">
              <el-descriptions-item label="К зачёту">{{ fmtMoney(card.vat.credited) }}</el-descriptions-item>
              <el-descriptions-item label="Не к зачёту">{{ fmtMoney(card.vat.nonCreditable) }}</el-descriptions-item>
              <el-descriptions-item label="Остаток">{{ fmtMoney(card.vat.remainder) }}</el-descriptions-item>
            </el-descriptions>
            <el-table :data="card.vat.allocations" size="small" empty-text="НДС не распределялся — получение ЭСФ само ничего не зачитывает" style="margin-top: 8px;">
              <el-table-column prop="kind" label="Вид" width="140" />
              <el-table-column label="Квартал" width="100"><template #default="{ row }">{{ row.quarter }}/{{ row.year }}</template></el-table-column>
              <el-table-column label="Сумма" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
              <el-table-column prop="method" label="Метод" width="120" />
              <el-table-column label="Правило" width="200"><template #default="{ row }">{{ row.ruleCode }}@{{ row.ruleVersion }}</template></el-table-column>
              <el-table-column prop="basis" label="Основание" min-width="160" />
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="История" name="history">
            <el-timeline aria-label="История действий">
              <el-timeline-item v-for="ev in card.timeline" :key="ev.id" :timestamp="fmtDateTime(ev.ts)">
                {{ ACTION_TEXT[ev.action] ?? ev.action }}<span v-if="ev.reason" class="muted"> — {{ ev.reason }}</span>
              </el-timeline-item>
            </el-timeline>
            <p v-if="!card.timeline.length" class="muted">Действий ещё не было.</p>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { fmtDate, fmtMoney, showError } from '../acc'
import { statusText } from './status'

const props = defineProps<{ id: string | null; canSend: boolean; busy?: boolean; reloadKey?: number }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'open', id: string): void; (e: 'reconcile'): void; (e: 'release', card: any): void }>()

const card = ref<any>(null)
const loading = ref(false)
const section = ref('main')

const TYPE_FULL: Record<string, string> = { ORDINARY_INVOICE: 'Основной', FIXED_INVOICE: 'Исправленный', ADDITIONAL_INVOICE: 'Дополнительный' }
const DECIDED: Record<string, string> = { APPROVED: 'Подтверждён', DECLINED: 'Отклонён', REVOKE_REQUESTED: 'Отзыв запрошен', REVOKE_CONFIRMED: 'Отзыв подтверждён', BASIS_LINKED: 'Основание привязано' }
const KIND_TEXT: Record<string, string> = { REVOKE: 'Отзыв', DECLINE: 'Отклонение', APPROVE: 'Подтверждение', CONFIRM_REVOKE: 'Подтверждение отзыва', LINK_BASIS: 'Привязка основания' }
const ACTION_TEXT: Record<string, string> = {
  ESF_PREPARE: 'Сформирован', ESF_SEND_STARTED: 'Отправка начата', ESF_UPLOAD: 'Отправлен в ИС ЭСФ', ESF_SEND_OUTCOME_UNKNOWN: 'Ответ ИС ЭСФ не получен',
  ESF_SEND_NOT_PROCESSED: 'Отправка не выполнена', ESF_RECONCILE_FOUND: 'Сверка: найден в ИС ЭСФ', ESF_RECONCILE_NOT_FOUND: 'Сверка: не найден в ИС ЭСФ',
  ESF_UNKNOWN_RELEASED: 'Разрешена повторная отправка', ESF_DECISION_PROPOSED: 'Решение предложено', ESF_DECISION_APPROVED: 'Решение утверждено',
  ESF_DECISION_REJECTED: 'Решение отклонено', ESF_DECISION_EXECUTED: 'Решение исполнено', ESF_DECISION_FAILED: 'Решение не исполнено',
}
const fmtDateTime = (v: string) => (v ? new Date(v).toLocaleString('ru-RU') : '')

async function load() {
  if (!props.id) { card.value = null; return }
  loading.value = true
  try { card.value = await api.get(`/accounting/esf/invoices/${props.id}`) } catch (e) { showError(e) }
  loading.value = false
}
watch(() => [props.id, props.reloadKey], () => { section.value = 'main'; load() }, { immediate: true })

async function copy() {
  try { await navigator.clipboard.writeText(card.value?.body ?? ''); ElMessage.success('XML скопирован') } catch { ElMessage.info('Выделите текст и скопируйте вручную') }
}
</script>

<style scoped>
.xml { white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, monospace; font-size: 12px; background: var(--el-fill-color-lighter); padding: 12px; max-height: 60vh; overflow: auto; }
.mono { font-family: ui-monospace, monospace; }
.muted { color: var(--el-text-color-secondary); }
.errors { margin-top: 12px; color: var(--el-color-danger); }
</style>
