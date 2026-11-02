<template>
  <!-- FP-039: пакеты налоговых правил — ставки, пороги, сроки с источниками; утверждение организацией. -->
  <div>
    <div class="page-header"><h1>Налоговые правила</h1></div>
    <p class="lead">Ставки и пороги, по которым FlowPOS считает налоги. Каждая версия неизменна и указывает источник. Налоговые расчёты работают только по пакету, утверждённому вашей организацией.</p>

    <el-card v-for="p in packs" :key="p.id" class="pack" shadow="never">
      <div class="pack-head">
        <div>
          <b>{{ p.code }} {{ p.version }}</b>
          <span class="muted"> · действует {{ fmtDate(p.validFrom) }} — {{ p.validTo ? fmtDate(p.validTo) : 'бессрочно' }}</span>
        </div>
        <el-tag v-if="p.adoption" type="success">Утверждён {{ fmtDate(p.adoption.approvedAt) }}</el-tag>
        <el-tag v-else type="warning">Не утверждён</el-tag>
      </div>

      <el-descriptions v-if="p.params?.vat && p.params?.payroll" :column="2" size="small" border class="params">
        <el-descriptions-item label="МРП / МЗП">{{ n(p.params.mrp) }} / {{ n(p.params.mzp) }} ₸</el-descriptions-item>
        <el-descriptions-item label="НДС">{{ p.params.vat.standardRate }}%, пониженные {{ p.params.vat.reducedRates.map((r: any) => r.rate + '%').join(', ') }}, 0%; квартал</el-descriptions-item>
        <el-descriptions-item label="Порог НДС">{{ n(p.params.vat.registrationThresholdMrp) }} МРП</el-descriptions-item>
        <el-descriptions-item label="300.00">{{ p.params.vat.filing }}; уплата {{ p.params.vat.payment }}</el-descriptions-item>
        <el-descriptions-item label="КПН">{{ p.params.cit.rate }}%</el-descriptions-item>
        <el-descriptions-item label="Упрощёнка (910.00)">{{ p.params.simplified.rate }}% ({{ p.params.simplified.maslikhatMin }}–{{ p.params.simplified.maslikhatMax }}% по решению маслихата), до {{ n(p.params.simplified.incomeLimitMrp) }} МРП, полугодие</el-descriptions-item>
        <el-descriptions-item label="Зарплата">ИПН {{ pct(p.params.payroll.ipn.rate1) }}/{{ pct(p.params.payroll.ipn.rate2) }}, ОПВ {{ pct(p.params.payroll.opv.rate) }}, ВОСМС {{ pct(p.params.payroll.vosms.rate) }}, ОПВР {{ pct(p.params.payroll.opvr.rate) }}, СО {{ pct(p.params.payroll.so.rate) }}, ООСМС {{ pct(p.params.payroll.oosms.rate) }}, СН {{ pct(p.params.payroll.sn.rate) }}</el-descriptions-item>
      </el-descriptions>

      <el-collapse class="more">
        <el-collapse-item :title="`Источники (${p.sources?.length ?? 0})`" name="src">
          <ul class="list"><li v-for="(s, i) in p.sources" :key="i"><b>{{ s.topic }}</b> — {{ s.npa }}<span v-if="s.articles">, {{ s.articles }}</span> <el-tag size="small" :type="s.confidence === 'ОФ' ? 'success' : s.confidence === 'ВТ' ? 'info' : 'danger'">{{ s.confidence }}</el-tag> <el-link v-if="s.url" :href="s.url" target="_blank" type="primary">ссылка</el-link></li></ul>
        </el-collapse-item>
      </el-collapse>

      <template v-if="!p.adoption">
        <el-alert type="warning" :closable="false" show-icon title="Перед утверждением сверьте с текстом НПА и отметьте каждый пункт:" class="warn" />
        <el-checkbox-group v-model="ack[p.id]" class="ack">
          <el-checkbox v-for="u in p.unverified ?? []" :key="u.key" :value="u.key">{{ u.text }}</el-checkbox>
        </el-checkbox-group>
        <el-button v-if="org.can('acc.policy.manage')" type="primary" :disabled="(ack[p.id]?.length ?? 0) < (p.unverified?.length ?? 0)" :loading="busy === p.id" @click="approve(p)">Утвердить пакет</el-button>
        <span v-else class="muted">Утверждает главный бухгалтер или владелец.</span>
      </template>
      <div v-else class="muted">Утвердил(а): {{ p.adoption.approvedBy.slice(0, 8) }} · отмечено пунктов: {{ p.adoption.acknowledged.length }}
        <el-button v-if="org.can('acc.policy.manage')" link type="danger" size="small" @click="revoke(p)">Отозвать</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtDate, showError } from '../accounting/acc'

const org = useOrgStore()
const packs = ref<any[]>([])
const ack = ref<Record<string, string[]>>({})
const busy = ref('')
const n = (v: number) => new Intl.NumberFormat('ru-RU').format(v)
const pct = (v: number) => `${+(v * 100).toFixed(2)}%`

async function load() {
  try { packs.value = (await api.get('/accounting/tax/packs')) as any } catch (e) { showError(e) }
}
async function approve(p: any) {
  busy.value = p.id
  try {
    await api.post(`/accounting/tax/packs/${p.id}/approve`, { acknowledged: ack.value[p.id] })
    ElMessage.success(`Пакет ${p.code} ${p.version} утверждён`)
    await load()
  } catch (e) { showError(e) }
  busy.value = ''
}
async function revoke(p: any) {
  try {
    const { value } = await ElMessageBox.prompt('Причина отзыва', `Отозвать ${p.code} ${p.version}`, { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })
    await api.post(`/accounting/tax/pack-approvals/${p.adoption.id}/revoke`, { reason: value })
    await load()
  } catch (e: any) { if (e !== 'cancel' && e !== 'close') showError(e) }
}
onMounted(load)
</script>

<style scoped>
.lead { color: var(--el-text-color-secondary); margin: -4px 0 16px; max-width: 760px; }
.pack { margin-bottom: 16px; }
.pack-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.params { margin-bottom: 8px; }
.more { margin-bottom: 12px; }
.list { margin: 0; padding-left: 18px; line-height: 1.8; }
.warn { margin-bottom: 8px; }
.ack { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-bottom: 12px; }
.ack :deep(.el-checkbox) { white-space: normal; height: auto; line-height: 1.4; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
</style>
