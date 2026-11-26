<template>
  <div>
    <PageHeader title="Бонусная программа" subtitle="Баллы покупателям за покупки: 1 балл = 1 ₸, оплата баллами части покупки" />

    <el-card shadow="never" class="settings">
      <div class="set-row">
        <el-switch v-model="form.isActive" active-text="Программа работает" :disabled="!canManage" />
        <div class="set-field"><span>Начислять</span><el-input v-model="form.accrualPercent" class="pct" :disabled="!canManage" /><span>% от суммы покупки</span></div>
        <div class="set-field"><span>Оплата баллами — до</span><el-input v-model="form.maxPayPercent" class="pct" :disabled="!canManage" /><span>% суммы документа</span></div>
        <el-button v-if="canManage" type="primary" :loading="busy" @click="saveSettings">Сохранить</el-button>
      </div>
      <div class="muted small">Баллы начисляются за проведённые реализации и чеки покупателю с даты запуска программы<template v-if="settings.startDate"> ({{ fmtDate(settings.startDate) }})</template>. Отмена продажи снимает её баллы.</div>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px;">
      <div class="filters">
        <el-input v-model="search" placeholder="Покупатель, телефон, БИН" clearable style="width: 260px;" :prefix-icon="Search" />
      </div>
      <el-table :data="rows" size="small" v-loading="loading" empty-text="Пока ни у кого нет баллов" class="clickable" @row-click="openCp">
        <el-table-column label="Покупатель" min-width="220"><template #default="{ row }">{{ row.name }}<div class="muted small">{{ row.phone || row.inn }}</div></template></el-table-column>
        <el-table-column label="Начислено" width="120" align="right"><template #default="{ row }">{{ fmtMoney(row.accrued) }}</template></el-table-column>
        <el-table-column label="Списано" width="120" align="right"><template #default="{ row }">{{ Number(row.spent) ? fmtMoney(row.spent) : '' }}</template></el-table-column>
        <el-table-column label="Остаток" width="130" align="right"><template #default="{ row }"><b :class="Number(row.balance) < 0 ? 'bad' : 'ok'">{{ fmtMoney(row.balance) }}</b></template></el-table-column>
      </el-table>
    </el-card>

    <el-drawer v-model="show" :title="cur?.name" size="520px">
      <template v-if="hist">
        <div class="bal">Остаток: <b>{{ fmtMoney(hist.balance) }}</b> баллов</div>
        <el-form label-position="top" class="mv">
          <el-radio-group v-model="mv.kind" size="small"><el-radio-button value="SPEND">Списать (оплата)</el-radio-button><el-radio-button value="ADJUST">Изменить вручную</el-radio-button></el-radio-group>
          <div class="mv-row">
            <el-input v-model="mv.points" :placeholder="mv.kind === 'SPEND' ? 'Сколько баллов' : '+10 или −10'" style="width: 150px;" />
            <el-input v-model="mv.comment" :placeholder="mv.kind === 'SPEND' ? 'Комментарий (необязательно)' : 'Причина (обязательно)'" />
            <el-button type="primary" :loading="busy" :disabled="!mv.points" @click="move">{{ mv.kind === 'SPEND' ? 'Списать' : 'Применить' }}</el-button>
          </div>
        </el-form>
        <el-table :data="hist.items" size="small" empty-text="Движений нет">
          <el-table-column label="Когда" width="120"><template #default="{ row }">{{ fmtDate(row.document?.date ?? row.createdAt) }}</template></el-table-column>
          <el-table-column label="Операция" min-width="200">
            <template #default="{ row }">{{ KIND[row.kind] }}<el-link v-if="row.document" type="primary" style="margin-left: 6px;" @click="router.push(`/accounting/trade/${row.document.id}`)">{{ row.document.number }}</el-link><div v-if="row.comment" class="muted small">{{ row.comment }}</div></template>
          </el-table-column>
          <el-table-column label="Баллы" width="100" align="right"><template #default="{ row }"><span :class="Number(row.points) < 0 ? 'bad' : 'ok'">{{ Number(row.points) > 0 ? '+' : '' }}{{ fmtMoney(row.points) }}</span></template></el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useOrgStore } from '@/stores/org'
import { fmtDate, fmtMoney } from '@/utils/format'
import { idem, showError } from '../accounting/acc'

const router = useRouter()
const org = useOrgStore()
const canManage = computed(() => org.can('acc.refs.manage'))
const KIND: Record<string, string> = { ACCRUAL: 'Начислено за покупку', SPEND: 'Оплата баллами', ADJUST: 'Изменено вручную' }
const settings = ref<any>({})
const form = ref({ isActive: false, accrualPercent: '0', maxPayPercent: '50' })
const all = ref<any[]>([])
const search = ref('')
const loading = ref(false)
const busy = ref(false)
const rows = computed(() => { const q = search.value.trim().toLowerCase(); return all.value.filter((r) => !q || `${r.name} ${r.phone ?? ''} ${r.inn ?? ''}`.toLowerCase().includes(q)) })

async function load() {
  loading.value = true
  try {
    settings.value = await api.get('/accounting/loyalty/settings')
    form.value = { isActive: !!settings.value.isActive, accrualPercent: String(Number(settings.value.accrualPercent)), maxPayPercent: String(Number(settings.value.maxPayPercent)) }
    all.value = (await api.get('/accounting/loyalty/balances')) as any
  } catch (e) { showError(e) } finally { loading.value = false }
}
async function saveSettings() {
  busy.value = true
  try { await api.put('/accounting/loyalty/settings', form.value); ElMessage.success('Настройки сохранены'); load() } catch (e) { showError(e) } finally { busy.value = false }
}

const show = ref(false)
const cur = ref<any>(null)
const hist = ref<any>(null)
const mv = ref({ kind: 'SPEND', points: '', comment: '' })
async function openCp(row: any) {
  cur.value = row
  hist.value = null
  mv.value = { kind: 'SPEND', points: '', comment: '' }
  show.value = true
  try { hist.value = await api.get(`/accounting/loyalty/counterparties/${row.counterpartyId}`) } catch (e) { showError(e) }
}
async function move() {
  busy.value = true
  try {
    hist.value = await api.post('/accounting/loyalty/moves', { counterpartyId: cur.value.counterpartyId, kind: mv.value.kind, points: mv.value.points.replace('−', '-'), comment: mv.value.comment }, idem())
    mv.value = { kind: mv.value.kind, points: '', comment: '' }
    ElMessage.success('Готово')
    all.value = (await api.get('/accounting/loyalty/balances')) as any
  } catch (e) { showError(e) } finally { busy.value = false }
}
onMounted(load)
</script>

<style scoped>
.set-row { display: flex; flex-wrap: wrap; gap: 14px 24px; align-items: center; margin-bottom: 8px; }
.set-field { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--fp-text-2); }
.pct { width: 70px; }
.pct :deep(input) { text-align: right; }
.clickable :deep(tr) { cursor: pointer; }
.muted { color: var(--fp-text-3); }
.small { font-size: 12px; }
.ok { color: var(--el-color-success); }
.bad { color: var(--el-color-danger); }
.bal { font-size: 16px; margin-bottom: 12px; }
.mv { margin-bottom: 16px; }
.mv-row { display: flex; gap: 8px; margin-top: 8px; }
</style>
