<template>
  <div>
    <div class="page-header"><h1>{{ t('settings') }}</h1></div>
    <el-card>
      <el-tabs v-model="tab" @tab-change="load">
        <el-tab-pane label="Учётная политика" name="policy" />
        <el-tab-pane label="Закрытие периода" name="period" />
        <el-tab-pane v-if="org.can('org.members.manage')" label="Пользователи и роли" name="members" />
        <el-tab-pane v-if="org.can('acc.audit.read')" label="Аудит" name="audit" />
      </el-tabs>

      <!-- Учётная политика -->
      <template v-if="tab === 'policy'">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;" title="Каждая настройка действует с указанной даты. Изменение — новая версия политики, прошлые версии сохраняются." />
        <el-button v-if="org.can('acc.policy.manage')" type="primary" :icon="Plus" @click="openPolicy" style="margin-bottom: 12px;">Новая версия</el-button>
        <el-table :data="policies" size="small" v-loading="loading">
          <el-table-column label="Действует с" width="120"><template #default="{ row }">{{ fmtDate(row.validFrom) }}</template></el-table-column>
          <el-table-column label="Плательщик НДС" width="140"><template #default="{ row }">{{ row.vatPayer ? 'да' : 'нет' }}</template></el-table-column>
          <el-table-column label="Налоговый режим" width="200"><template #default="{ row }">{{ REGIMES[row.taxRegime] || row.taxRegime }}</template></el-table-column>
          <el-table-column label="Оценка запасов" width="140" prop="inventoryMethod" />
          <el-table-column label="Отриц. остатки" width="130"><template #default="{ row }">{{ row.allowNegativeStock ? 'разрешены' : 'запрещены' }}</template></el-table-column>
          <el-table-column label="Валюта" width="80" prop="baseCurrency" />
        </el-table>
      </template>

      <!-- Закрытие периода -->
      <template v-else-if="tab === 'period'">
        <p>Период закрыт по: <b>{{ lock?.lockedUntil ? fmtDate(lock.lockedUntil) : 'не закрыт' }}</b></p>
        <el-form v-if="org.can('acc.period.lock')" label-width="180px" style="max-width: 560px;">
          <el-form-item label="Закрыть период по дату">
            <el-date-picker v-model="lockForm.date" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" clearable />
          </el-form-item>
          <el-form-item label="Причина (при открытии)" :required="reopening">
            <el-input v-model="lockForm.reason" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="saveLock">{{ reopening ? 'Переоткрыть период' : 'Закрыть период' }}</el-button>
          </el-form-item>
        </el-form>
        <div class="hint">Документы с датой в закрытом периоде нельзя провести или изменить. Исправления — сторно текущей датой. Открыть закрытый период может главный бухгалтер или владелец, с записью в аудит.</div>
      </template>

      <!-- Пользователи -->
      <template v-else-if="tab === 'members'">
        <div class="filters">
          <el-input v-model="memberForm.email" placeholder="email пользователя" style="width: 240px;" />
          <el-select v-model="memberForm.role" placeholder="Роль" style="width: 200px;">
            <el-option v-for="r in roles" :key="r.code" :value="r.code" :label="lang === 'kk' ? r.label.kk : r.label.ru" />
          </el-select>
          <el-button type="primary" @click="saveMember">Добавить / изменить</el-button>
        </div>
        <el-table :data="members" size="small" v-loading="loading">
          <el-table-column label="Пользователь" min-width="220"><template #default="{ row }">{{ row.user?.lastName }} {{ row.user?.firstName }} · {{ row.user?.email }}</template></el-table-column>
          <el-table-column label="Роль" width="200"><template #default="{ row }">{{ roleLabel(row.role) }}</template></el-table-column>
          <el-table-column label="Активен" width="90"><template #default="{ row }">{{ row.isActive ? 'да' : 'нет' }}</template></el-table-column>
          <el-table-column width="120">
            <template #default="{ row }">
              <el-button link size="small" type="primary" @click="memberForm = { email: row.user?.email, role: row.role }">Изменить</el-button>
            </template>
          </el-table-column>
        </el-table>
        <h4 style="margin-top: 20px;">Права ролей</h4>
        <el-table :data="roles" size="small">
          <el-table-column label="Роль" width="200"><template #default="{ row }">{{ lang === 'kk' ? row.label.kk : row.label.ru }}</template></el-table-column>
          <el-table-column label="Права"><template #default="{ row }"><span v-for="p in row.permissions" :key="p" class="perm">{{ p }}</span></template></el-table-column>
        </el-table>
      </template>

      <!-- Аудит -->
      <template v-else-if="tab === 'audit'">
        <el-table :data="audit" size="small" v-loading="loading">
          <el-table-column label="Время" width="170"><template #default="{ row }">{{ new Date(row.ts).toLocaleString('ru-RU') }}</template></el-table-column>
          <el-table-column label="Действие" prop="action" width="180" />
          <el-table-column label="Объект" prop="entity" width="150" />
          <el-table-column label="ID" prop="entityId" width="120" show-overflow-tooltip />
          <el-table-column label="Причина" prop="reason" min-width="160" />
          <el-table-column label="Данные" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ row.after ? JSON.stringify(row.after) : '' }}</template></el-table-column>
        </el-table>
      </template>
    </el-card>

    <el-dialog v-model="policyVisible" title="Новая версия учётной политики" width="480px">
      <el-form :model="policyForm" label-width="170px">
        <el-form-item label="Действует с"><el-date-picker v-model="policyForm.validFrom" type="date" value-format="YYYY-MM-DD" format="DD.MM.YYYY" /></el-form-item>
        <el-form-item label="Плательщик НДС"><el-switch v-model="policyForm.vatPayer" /></el-form-item>
        <el-form-item label="Налоговый режим">
          <el-select v-model="policyForm.taxRegime"><el-option v-for="(l, k) in REGIMES" :key="k" :value="k" :label="l" /></el-select>
        </el-form-item>
        <el-form-item label="Оценка запасов">
          <el-select v-model="policyForm.inventoryMethod"><el-option value="FIFO" label="ФИФО" /><el-option value="AVERAGE" label="Средневзвешенная" /></el-select>
        </el-form-item>
        <el-form-item label="Отрицательные остатки"><el-switch v-model="policyForm.allowNegativeStock" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="policyVisible = false">{{ t('close') }}</el-button>
        <el-button type="primary" @click="savePolicy">{{ t('save') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { fmtDate, idem, showError } from './acc'

const org = useOrgStore()
const { t, lang } = useI18n()
const REGIMES: Record<string, string> = { GENERAL: 'Общеустановленный', SIMPLIFIED: 'Упрощённая декларация', RETAIL_TAX: 'Розничный налог', OTHER: 'Иной' }

const tab = ref('policy')
const loading = ref(false)
const policies = ref<any[]>([])
const lock = ref<any>(null)
const lockForm = ref<{ date: string | null; reason: string }>({ date: null, reason: '' })
const members = ref<any[]>([])
const roles = ref<any[]>([])
const audit = ref<any[]>([])
const memberForm = ref<any>({ email: '', role: 'accountant' })
const policyVisible = ref(false)
const policyForm = ref<any>({})

const reopening = computed(() => !!lock.value?.lockedUntil && (!lockForm.value.date || lockForm.value.date < String(lock.value.lockedUntil).slice(0, 10)))

function roleLabel(code: string) {
  const r = roles.value.find((x) => x.code === code)
  return r ? (lang.value === 'kk' ? r.label.kk : r.label.ru) : code
}

async function load() {
  loading.value = true
  try {
    if (tab.value === 'policy') policies.value = (await api.get('/accounting/policy')) as any
    if (tab.value === 'period') {
      lock.value = await api.get('/accounting/periods/lock')
      lockForm.value = { date: lock.value?.lockedUntil ? String(lock.value.lockedUntil).slice(0, 10) : null, reason: '' }
    }
    if (tab.value === 'members') {
      roles.value = (await api.get('/accounting/roles')) as any
      members.value = (await api.get('/accounting/members')) as any
    }
    if (tab.value === 'audit') audit.value = (await api.get('/accounting/audit', { params: { limit: 200 } })) as any
  } catch (e) { showError(e) }
  loading.value = false
}

function openPolicy() {
  const last = policies.value[0] || {}
  policyForm.value = {
    validFrom: dayjs().startOf('month').format('YYYY-MM-DD'), vatPayer: !!last.vatPayer, taxRegime: last.taxRegime || 'GENERAL',
    inventoryMethod: last.inventoryMethod || 'FIFO', allowNegativeStock: !!last.allowNegativeStock,
  }
  policyVisible.value = true
}

async function savePolicy() {
  try {
    await api.post('/accounting/policy', policyForm.value, idem())
    ElMessage.success('Версия политики сохранена')
    policyVisible.value = false
    load()
  } catch (e) { showError(e) }
}

async function saveLock() {
  if (reopening.value && !lockForm.value.reason) { ElMessage.warning('Укажите причину открытия закрытого периода'); return }
  try {
    await api.put('/accounting/periods/lock', { lockedUntil: lockForm.value.date || null, reason: lockForm.value.reason || undefined }, idem())
    ElMessage.success('Сохранено')
    load()
  } catch (e) { showError(e) }
}

async function saveMember() {
  try {
    await api.post('/accounting/members', memberForm.value, idem())
    ElMessage.success('Доступ сохранён')
    memberForm.value = { email: '', role: 'accountant' }
    load()
  } catch (e) { showError(e) }
}

onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.hint { margin-top: 10px; color: #909399; font-size: 12px; }
.perm { display: inline-block; font-size: 11px; background: #f4f4f5; border-radius: 3px; padding: 0 5px; margin: 1px 4px 1px 0; }
</style>
