<template>
  <div>
    <div class="page-header">
      <h1>Закрытие месяца</h1>
      <div class="actions">
        <el-date-picker v-model="period" type="month" value-format="YYYY-MM" format="MM.YYYY" :clearable="false" style="width: 140px;" @change="load" />
        <el-button @click="load" :loading="loading">Проверить</el-button>
      </div>
    </div>

    <el-row :gutter="12" v-if="st">
      <el-col :xs="24" :lg="15">
        <el-card>
          <template #header>
            <div class="card-head">
              <span>Проверки за {{ monthLabel }}</span>
              <el-tag :type="st.closed ? 'success' : st.canClose ? 'primary' : 'danger'">{{ st.closed ? `Закрыт (по ${fmtDate(st.lockedUntil)})` : st.canClose ? 'Можно закрывать' : 'Есть блокирующие проблемы' }}</el-tag>
            </div>
          </template>
          <div v-for="s in st.steps" :key="s.code" class="step">
            <el-icon class="ico" :class="s.status"><component :is="icon(s.status)" /></el-icon>
            <div class="body">
              <div class="title">{{ s.title }}</div>
              <div class="msg">{{ s.message }}</div>
              <div v-if="s.fix && s.status !== 'ok'" class="fix">Что сделать: {{ s.fix }}</div>
            </div>
            <el-button v-if="s.link && s.status !== 'ok'" link type="primary" @click="router.push(s.link)">Открыть</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="9">
        <el-card v-if="!st.closed">
          <template #header>Что сделает закрытие</template>
          <ol class="acts"><li v-for="a in st.actions" :key="a">{{ a }}</li></ol>
          <el-button v-if="org.can('acc.period.lock')" type="primary" size="large" style="width: 100%;" :disabled="!st.canClose" :loading="busy" @click="close">Закрыть {{ monthLabel }}</el-button>
          <div class="hint">Проводки закрытия формируются детерминированно: повторное закрытие после открытия даёт тот же результат, если учёт не менялся.</div>
        </el-card>

        <el-card v-if="summary" style="margin-top: 12px;">
          <template #header>
            <div class="card-head">
              <span>Итоги на конец месяца</span>
              <el-tag v-if="reproducible === true" type="success" size="small">совпадает с прошлым закрытием</el-tag>
              <el-tag v-else-if="reproducible === false" type="warning" size="small">отличается от прошлого закрытия</el-tag>
            </div>
          </template>
          <dl class="sum">
            <dt>Деньги (10xx)</dt><dd>{{ fmtMoney(summary.cash) }}</dd>
            <dt>Товары и запасы (13xx)</dt><dd>{{ fmtMoney(summary.stock) }}</dd>
            <dt>Долги покупателей (1210)</dt><dd>{{ fmtMoney(summary.receivables) }}</dd>
            <dt>Долги поставщикам (3310)</dt><dd>{{ fmtMoney(summary.payables) }}</dd>
            <dt title="Сальдо счетов, а не декларация: что принято к зачёту, — в регистре «НДС к зачёту» по ЭСФ (FP-019)">Сальдо НДС по счетам (3130 − 1420)</dt><dd>{{ fmtMoney(summary.vatPayable) }}</dd>
            <dt>Выручка с начала года</dt><dd>{{ fmtMoney(summary.revenueYtd) }}</dd>
            <dt>Валовая прибыль с начала года</dt><dd>{{ fmtMoney(summary.grossProfitYtd) }}</dd>
            <dt>Прибыль с начала года</dt><dd><b>{{ fmtMoney(summary.profitYtd) }}</b></dd>
            <dt>Курсовые разницы</dt><dd>+{{ fmtMoney(summary.revaluation?.gain) }} / −{{ fmtMoney(summary.revaluation?.loss) }}</dd>
            <dt v-if="summary.finResult">Финрезультат на 5610</dt><dd v-if="summary.finResult">{{ fmtMoney(summary.finResult.result) }}</dd>
            <dt>Обороты Дт = Кт</dt><dd>{{ fmtMoney(summary.turnover?.debit) }}</dd>
          </dl>
          <div class="links">
            <el-button link type="primary" @click="router.push({ path: '/accounting/statements', query: { form: 'balance' } })">Баланс</el-button>
            <el-button link type="primary" @click="router.push({ path: '/accounting/statements', query: { form: 'profit-loss' } })">ОПиУ</el-button>
            <el-button link type="primary" @click="router.push({ path: '/accounting/reports/trial-balance', query: { from: st.from, to: st.to } })">ОСВ</el-button>
          </div>
          <el-button v-if="st.closed && org.can('acc.period.override')" type="warning" plain style="width: 100%; margin-top: 10px;" @click="reopen">Открыть месяц для исправлений</el-button>
        </el-card>
      </el-col>
    </el-row>

    <el-card style="margin-top: 12px;">
      <template #header>История закрытий</template>
      <el-table :data="history" size="small" empty-text="Месяцы ещё не закрывались">
        <el-table-column label="Месяц" width="110" prop="period" />
        <el-table-column label="Статус" width="120"><template #default="{ row }"><el-tag size="small" :type="row.status === 'CLOSED' ? 'success' : 'info'">{{ row.status === 'CLOSED' ? 'Закрыт' : 'Открыт' }}</el-tag></template></el-table-column>
        <el-table-column label="Закрыт" width="170"><template #default="{ row }">{{ new Date(row.closedAt).toLocaleString('ru-RU') }}</template></el-table-column>
        <el-table-column label="Прибыль с начала года" width="180" align="right"><template #default="{ row }">{{ fmtMoney(row.summary?.profitYtd) }}</template></el-table-column>
        <el-table-column label="Деньги" width="150" align="right"><template #default="{ row }">{{ fmtMoney(row.summary?.cash) }}</template></el-table-column>
        <el-table-column label="Причина открытия" min-width="200" prop="reopenReason" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import 'dayjs/locale/ru'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheckFilled, WarningFilled, CircleCloseFilled, InfoFilled } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney, showError, idem } from './acc'

const router = useRouter()
const org = useOrgStore()
const period = ref(dayjs().subtract(1, 'month').format('YYYY-MM'))
const st = ref<any>(null)
const history = ref<any[]>([])
const loading = ref(false)
const busy = ref(false)
const fresh = ref<any>(null)
const monthLabel = computed(() => dayjs(`${period.value}-01`).locale('ru').format('MMMM YYYY'))
const summary = computed(() => fresh.value?.summary ?? (st.value?.closed ? st.value?.last?.summary : null))
const reproducible = computed(() => fresh.value?.reproducible ?? null)
const icon = (s: string) => ({ ok: CircleCheckFilled, warn: WarningFilled, error: CircleCloseFilled }[s] ?? InfoFilled)

async function load() {
  loading.value = true
  fresh.value = null
  try {
    st.value = await api.get(`/accounting/closing/${period.value}`)
    history.value = (await api.get('/accounting/closing')) as any
  } catch (e) { showError(e) }
  loading.value = false
}

async function close() {
  try { await ElMessageBox.confirm(`Закрыть ${monthLabel.value}? После закрытия документы с датой по ${fmtDate(st.value.to)} изменить нельзя (только с открытием месяца главным бухгалтером).`, 'Закрытие месяца', { confirmButtonText: 'Закрыть месяц', cancelButtonText: 'Отмена', type: 'warning' }) } catch { return }
  busy.value = true
  try {
    const r = (await api.post(`/accounting/closing/${period.value}/close`, {}, idem())) as any
    await load()
    fresh.value = r
    ElMessage.success(`${monthLabel.value} закрыт`)
  } catch (e) { showError(e) }
  busy.value = false
}

async function reopen() {
  let reason = ''
  try { reason = ((await ElMessageBox.prompt('Почему нужно открыть закрытый месяц? Причина попадёт в журнал аудита.', 'Открыть месяц', { confirmButtonText: 'Открыть', cancelButtonText: 'Отмена', inputValidator: (v: string) => !!v?.trim() || 'Укажите причину' })) as any).value } catch { return }
  try {
    await api.post(`/accounting/closing/${period.value}/reopen`, { reason })
    ElMessage.success('Месяц открыт. Закрывающие проводки месяца отменены.')
    await load()
  } catch (e) { showError(e) }
}

onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.step { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.step:last-child { border-bottom: 0; }
.ico { font-size: 20px; margin-top: 2px; flex: none; }
.ico.ok { color: #67c23a; } .ico.warn { color: #e6a23c; } .ico.error { color: #f56c6c; } .ico.todo { color: #909399; }
.body { flex: 1; }
.title { font-weight: 600; }
.msg { color: #606266; font-size: 13px; }
.fix { color: #909399; font-size: 12px; margin-top: 2px; }
.acts { padding-left: 18px; margin: 0 0 14px; line-height: 1.6; }
.hint { color: #909399; font-size: 12px; margin-top: 10px; }
.sum { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; margin: 0; }
.sum dt { color: #606266; } .sum dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.links { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
</style>
