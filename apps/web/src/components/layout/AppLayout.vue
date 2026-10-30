<template>
  <el-container class="app-layout" style="height: 100vh;">
    <el-aside :width="`${sidebarWidth}px`" class="sidebar">
      <div class="sidebar-logo">
        <span class="logo-icon">⚡</span>
        <span class="logo-text" v-if="!collapsed">FlowPOS</span>
      </div>
      <el-menu
        :default-active="activeMenu"
        router
        :collapse="collapsed"
        class="sidebar-menu"
        background-color="#001529"
        text-color="#a6adb4"
        active-text-color="#ffffff"
      >
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <template #title>Дашборд</template>
        </el-menu-item>

        <el-sub-menu index="catalog">
          <template #title>
            <el-icon><Box /></el-icon>
            <span>Каталог</span>
          </template>
          <el-menu-item index="/catalog/items">Номенклатура</el-menu-item>
          <el-menu-item index="/catalog/warehouses">Склады</el-menu-item>
          <el-menu-item index="/catalog/counterparties">Контрагенты</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="trade">
          <template #title>
            <el-icon><ShoppingBag /></el-icon>
            <span>Торговля</span>
          </template>
          <el-menu-item index="/trade/purchases">Закупки</el-menu-item>
          <el-menu-item index="/trade/sales">Продажи</el-menu-item>
          <el-menu-item index="/trade/stocks">Остатки</el-menu-item>
          <el-menu-item index="/trade/transfers">Перемещения</el-menu-item>
          <el-menu-item index="/trade/inventories">Инвентаризации</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="pos">
          <template #title>
            <el-icon><Monitor /></el-icon>
            <span>FlowPOS</span>
          </template>
          <el-menu-item index="/pos/terminals">Кассы</el-menu-item>
          <el-menu-item index="/pos/shifts">Смены</el-menu-item>
          <el-menu-item index="/pos/receipts">Чеки</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="hr">
          <template #title>
            <el-icon><UserFilled /></el-icon>
            <span>Персонал</span>
          </template>
          <el-menu-item index="/hr/employees">Сотрудники</el-menu-item>
          <el-menu-item index="/hr/schedule">График смен</el-menu-item>
          <el-menu-item index="/hr/timesheet">Табель</el-menu-item>
          <el-menu-item index="/hr/payrolls">Зарплата</el-menu-item>
        </el-sub-menu>

        <el-sub-menu index="accounting">
          <template #title>
            <el-icon><Notebook /></el-icon>
            <span>{{ t('accounting') }}</span>
          </template>
          <el-menu-item index="/accounting/trade">{{ t('trade') }}</el-menu-item>
          <el-menu-item index="/accounting/documents">{{ t('documents') }}</el-menu-item>
          <el-menu-item index="/accounting/bank-import">{{ t('bankImport') }}</el-menu-item>
          <el-menu-item v-if="org.can('acc.esf.read')" index="/accounting/esf">{{ t('esf') }}</el-menu-item>
          <el-menu-item index="/accounting/autopilot">
            {{ t('autopilot') }}
            <el-badge v-if="autopilotIssues" :value="autopilotIssues" type="danger" style="margin-left: 8px; line-height: 1;" />
          </el-menu-item>
          <el-menu-item index="/accounting/closing">{{ t('monthClosing') }}</el-menu-item>
          <el-menu-item index="/accounting/statements">{{ t('statements') }}</el-menu-item>
          <el-menu-item index="/accounting/reports/stock">{{ t('stockReport') }}</el-menu-item>
          <el-menu-item index="/accounting/reports/settlements">{{ t('settlements') }}</el-menu-item>
          <el-menu-item index="/accounting/reports/trial-balance">ОСВ</el-menu-item>
          <el-menu-item index="/accounting/reports/account-card">{{ t('accountCard') }}</el-menu-item>
          <el-menu-item index="/accounting/reports/journal">{{ t('journal') }}</el-menu-item>
          <el-menu-item index="/accounting/chart">{{ t('chart') }}</el-menu-item>
          <el-menu-item index="/accounting/refs">{{ t('refs') }}</el-menu-item>
          <el-menu-item index="/accounting/settings">{{ t('settings') }}</el-menu-item>
        </el-sub-menu>

        <el-menu-item index="/analytics">
          <el-icon><TrendCharts /></el-icon>
          <template #title>Аналитика</template>
        </el-menu-item>

        <el-sub-menu index="settings">
          <template #title>
            <el-icon><Setting /></el-icon>
            <span>Настройки</span>
          </template>
          <el-menu-item index="/settings/users">Пользователи</el-menu-item>
          <el-menu-item index="/settings/integration">Интеграция 1С</el-menu-item>
          <el-menu-item index="/settings/conflicts">
            <span>Конфликты</span>
            <el-badge v-if="conflictCount > 0" :value="conflictCount" type="danger" style="margin-left: 6px;" />
          </el-menu-item>
          <el-menu-item index="/settings/simulator">Симулятор</el-menu-item>
        </el-sub-menu>
      </el-menu>

      <div class="sidebar-footer">
        <el-button
          text
          :icon="collapsed ? 'Expand' : 'Fold'"
          @click="toggleCollapse"
          style="color: #a6adb4;"
        >
          <el-icon v-if="!collapsed"><Fold /></el-icon>
          <el-icon v-else><Expand /></el-icon>
        </el-button>
      </div>
    </el-aside>

    <el-container>
      <el-header class="app-header" height="56px">
        <div class="header-left">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/dashboard' }">FlowPOS</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <el-select
            v-if="org.organizations.length" :model-value="org.currentId" size="small" class="org-select"
            :placeholder="t('organization')" @change="switchOrg"
          >
            <el-option v-for="o in org.organizations" :key="o.id" :value="o.id" :label="o.name" />
          </el-select>
          <el-button size="small" :icon="Plus" circle :title="t('newOrganization')" @click="orgDialog = true" />
          <el-radio-group :model-value="lang" size="small" @change="(v: any) => setLang(v)">
            <el-radio-button value="ru">RU</el-radio-button>
            <el-radio-button value="kk">ҚЗ</el-radio-button>
          </el-radio-group>
          <el-dropdown @command="handleUserCommand">
            <span class="user-info">
              <el-avatar :size="32" style="background: #409eff;">
                {{ userInitials }}
              </el-avatar>
              <span class="user-name" v-if="!collapsed">{{ auth.user?.firstName }}</span>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">Выйти</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="app-main">
        <RouterView :key="org.currentId || 'org'" />
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="orgDialog" :title="t('newOrganization')" width="460px">
    <el-form :model="orgForm" label-width="150px">
      <el-form-item label="Наименование"><el-input v-model="orgForm.name" /></el-form-item>
      <el-form-item label="Атауы (қаз.)"><el-input v-model="orgForm.nameKk" /></el-form-item>
      <el-form-item label="БИН / ИИН"><el-input v-model="orgForm.inn" maxlength="12" /></el-form-item>
      <el-form-item label="Форма">
        <el-select v-model="orgForm.legalForm"><el-option value="TOO" label="ТОО" /><el-option value="IP" label="ИП" /><el-option value="AO" label="АО" /><el-option value="OTHER" label="Иная" /></el-select>
      </el-form-item>
      <el-form-item label="Плательщик НДС"><el-switch v-model="orgForm.vatPayer" /></el-form-item>
      <el-form-item label="Налоговый режим">
        <el-select v-model="orgForm.taxRegime">
          <el-option value="GENERAL" label="Общеустановленный" /><el-option value="SIMPLIFIED" label="Упрощённая декларация" />
          <el-option value="RETAIL_TAX" label="Розничный налог" /><el-option value="OTHER" label="Иной" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="orgDialog = false">Отмена</el-button>
      <el-button type="primary" :disabled="!orgForm.name" @click="createOrg">Создать</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter, RouterView } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const org = useOrgStore()
const { t, lang, setLang } = useI18n()
const orgDialog = ref(false)
const orgForm = ref<any>({ name: '', nameKk: '', inn: '', legalForm: 'TOO', vatPayer: false, taxRegime: 'GENERAL' })

async function switchOrg(id: string) {
  await org.select(id)
  ElMessage.success(`Организация: ${org.current?.name || ''}`)
}

async function createOrg() {
  try {
    const created = await org.create(orgForm.value)
    ElMessage.success(`Создана организация ${created.name}`)
    orgDialog.value = false
    orgForm.value = { name: '', nameKk: '', inn: '', legalForm: 'TOO', vatPayer: false, taxRegime: 'GENERAL' }
  } catch (e: any) {
    ElMessage.error(e?.message || 'Ошибка')
  }
}

const collapsed = ref(false)
const conflictCount = ref(0)
const autopilotIssues = ref(0)
async function loadAutopilotIssues() {
  try { autopilotIssues.value = ((await api.get('/accounting/autopilot/status')) as any).openIssues || 0 } catch { autopilotIssues.value = 0 }
}
const sidebarWidth = computed(() => collapsed.value ? 64 : 220)
const activeMenu = computed(() => route.path)
const currentTitle = computed(() => (route.meta?.title as string) || '')
const userInitials = computed(() => {
  const u = auth.user
  if (!u) return '?'
  return `${u.firstName?.[0] || ''}${u.lastName?.[0] || ''}`.toUpperCase()
})

function toggleCollapse() {
  collapsed.value = !collapsed.value
}

function handleUserCommand(cmd: string) {
  if (cmd === 'logout') {
    auth.logout()
    router.push('/login')
  }
}

async function loadConflictCount() {
  try {
    const res = await api.get('/sync/conflicts')
    conflictCount.value = (res.data?.data ?? []).length
  } catch { /* silent */ }
}

watch(() => org.currentId, () => loadAutopilotIssues())

onMounted(() => {
  org.load()
  loadConflictCount()
  loadAutopilotIssues()
  setInterval(() => { loadConflictCount(); loadAutopilotIssues() }, 60_000)
})
</script>

<style scoped>
.app-layout { background: #f5f7fa; }

.sidebar {
  background: #001529;
  display: flex;
  flex-direction: column;
  transition: width 0.3s;
  overflow: hidden;
}

.sidebar-logo {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 8px;
  border-bottom: 1px solid #1a3251;
}

.logo-icon { font-size: 20px; }
.logo-text {
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.sidebar-menu {
  flex: 1;
  border-right: none;
  overflow-y: auto;
  overflow-x: hidden;
}

.sidebar-footer {
  padding: 8px;
  border-top: 1px solid #1a3251;
  display: flex;
  justify-content: center;
}

.app-header {
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}

.header-right { display: flex; align-items: center; gap: 12px; }
.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #606266;
}
.user-name { font-size: 14px; }
.org-select { width: 220px; }
@media (max-width: 900px) { .org-select { width: 140px; } }

.app-main {
  background: #f5f7fa;
  padding: 20px;
  overflow-y: auto;
}
</style>
