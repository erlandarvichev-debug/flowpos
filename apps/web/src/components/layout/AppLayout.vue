<template>
  <el-container class="app-layout" style="height: 100vh;">
    <div v-if="isMobile && mobileOpen" class="sidebar-backdrop" @click="mobileOpen = false" />
    <el-aside :width="`${sidebarWidth}px`" class="sidebar" :class="{ mobile: isMobile, open: mobileOpen }">
      <div class="sidebar-logo">
        <img v-if="collapsed && !isMobile" src="/brand/flowpos-icon-64.png" alt="FlowPOS" class="logo-icon-img" />
        <img v-else src="/brand/flowpos-wordmark.png" alt="FlowPOS" class="logo-wordmark" />
      </div>
      <el-menu
        :default-active="activeMenu"
        router
        unique-opened
        :collapse="collapsed && !isMobile"
        class="sidebar-menu"
      >
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <template #title>Главное</template>
        </el-menu-item>

        <!-- Разделы — из components/layout/menu.ts (тот же список показывают страницы-плитки /section/<ключ>).
             Нажатие на заголовок раздела открывает его страницу с плитками. -->
        <el-sub-menu v-for="sec in menu" :key="sec.key" :index="sec.key">
          <template #title>
            <el-icon :style="{ color: SECTION_TONES[sec.key] }"><component :is="sec.icon" /></el-icon>
            <span class="sec-title" @click="openSection(sec.key)">{{ sec.title }}</span>
          </template>
          <el-menu-item v-for="it in sec.items" :key="it.path" :index="it.path">
            <el-icon class="sub-ic"><component :is="it.icon" /></el-icon>
            <span class="sub-title">{{ it.title }}</span>
            <el-badge v-if="it.badge === 'autopilot' && autopilotIssues" :value="autopilotIssues" type="danger" style="margin-left: 8px; line-height: 1;" />
          </el-menu-item>
        </el-sub-menu>

        <!-- Управление платформой — отдельный адрес (ad.flowpos.kz); /platform туда переводит. -->
        <el-menu-item v-if="solutions.isPlatformAdmin" index="/platform">
          <el-icon><Platform /></el-icon>
          <template #title>Управление платформой ↗</template>
        </el-menu-item>
      </el-menu>

      <div v-if="!isMobile" class="sidebar-footer">
        <el-button
          text
          :icon="collapsed ? 'Expand' : 'Fold'"
          @click="toggleCollapse"
          class="collapse-btn"
        >
          <el-icon v-if="!collapsed"><Fold /></el-icon>
          <el-icon v-else><Expand /></el-icon>
        </el-button>
      </div>
    </el-aside>

    <el-container>
      <el-header class="app-header" height="56px">
        <div class="header-left">
          <el-button v-if="isMobile" text class="burger" @click="mobileOpen = true"><el-icon :size="20"><Menu /></el-icon></el-button>
          <el-breadcrumb v-if="!isMobile" separator="/">
            <el-breadcrumb-item :to="{ path: '/dashboard' }">FlowPOS</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
          <GlobalSearch class="header-search" />
        </div>
        <div class="header-right">
          <el-dropdown v-if="quick.length" trigger="click" @command="(p: string) => router.push(p)">
            <el-button type="primary" :icon="Plus" class="quick-btn">Создать</el-button>
            <template #dropdown>
              <el-dropdown-menu class="quick-menu">
                <el-dropdown-item v-for="q in quick" :key="q.path" :command="q.path" :divided="q.divided">
                  <el-icon :style="{ color: q.color }"><component :is="q.icon" /></el-icon>{{ q.title }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-dropdown trigger="click" @command="(m: any) => setMode(m)">
            <el-button circle :icon="isDark ? Moon : Sunny" :title="isDark ? 'Тёмная тема' : 'Светлая тема'" class="theme-btn" />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="light" :class="{ 'is-on': mode === 'light' }"><el-icon><Sunny /></el-icon>Светлая</el-dropdown-item>
                <el-dropdown-item command="dark" :class="{ 'is-on': mode === 'dark' }"><el-icon><Moon /></el-icon>Тёмная</el-dropdown-item>
                <el-dropdown-item command="system" :class="{ 'is-on': mode === 'system' }"><el-icon><Monitor /></el-icon>Как в системе</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip :content="taskHint" placement="bottom">
            <el-badge :value="taskSum.overdue || taskSum.today || ''" :hidden="!taskSum.overdue && !taskSum.today" :type="taskSum.overdue ? 'danger' : 'warning'" class="bell">
              <el-button circle :icon="Bell" @click="router.push('/tasks')" />
            </el-badge>
          </el-tooltip>
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
              <el-avatar :size="32" class="avatar">
                {{ userInitials }}
              </el-avatar>
              <span class="user-name" v-if="!collapsed && !isMobile">{{ auth.user?.firstName }}</span>
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
        <RouterView :key="`${org.currentId || 'org'}:${route.path}`" />
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="orgDialog" :title="t('newOrganization')" width="460px">
    <el-segmented v-model="orgMode" :options="[{ label: 'По ЭЦП', value: 'ecp' }, { label: 'Вручную', value: 'manual' }]" block style="margin-bottom: 16px;" />
    <el-form :model="orgForm" label-width="150px">
      <template v-if="orgMode === 'ecp'">
        <p class="ecp-hint">Наименование и БИН/ИИН возьмутся из сертификата. Нужен NCALayer и ключ первого руководителя или сотрудника с правом подписи (для ИП — ключ ИП).</p>
      </template>
      <template v-else>
      <el-form-item label="Наименование"><el-input v-model="orgForm.name" /></el-form-item>
      <el-form-item label="Атауы (қаз.)"><el-input v-model="orgForm.nameKk" /></el-form-item>
      <el-form-item label="БИН / ИИН"><el-input v-model="orgForm.inn" maxlength="12" /></el-form-item>
      <el-form-item label="Форма">
        <el-select v-model="orgForm.legalForm"><el-option value="TOO" label="ТОО" /><el-option value="IP" label="ИП" /><el-option value="AO" label="АО" /><el-option value="OTHER" label="Иная" /></el-select>
      </el-form-item>
      </template>
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
      <el-button v-if="orgMode === 'ecp'" type="primary" :loading="ecpBusy" @click="createOrgEcp">Подписать ЭЦП и создать</el-button>
      <el-button v-else type="primary" :disabled="!orgForm.name" @click="createOrg">Создать</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, RouterView } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useOrgStore } from '@/stores/org'
import { useSolutionsStore } from '@/stores/solutions'
import { useI18n } from '@/composables/useI18n'
import { Bell, Monitor, Moon, Plus, Sunny } from '@element-plus/icons-vue'
import { apply as applyTheme, useTheme } from '@/composables/useTheme'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { signChallengeCms, NcaLayerError, NCALAYER_DOWNLOAD } from '@/utils/ncalayer'
import { SECTION_TONES, buildMenu } from './menu'
import GlobalSearch from './GlobalSearch.vue'
import { Menu } from '@element-plus/icons-vue'

const route = useRoute()
const { mode, isDark, setMode } = useTheme()
const router = useRouter()
const auth = useAuthStore()
const org = useOrgStore()
const solutions = useSolutionsStore()
// Супервайзеру учёт и бухгалтерия не нужны (и прав на них у роли нет) — показываем только «Торговые».
const notSupervisor = computed(() => org.context?.role !== 'supervisor')
const showTrade = computed(() => solutions.trade && notSupervisor.value)
const showAcc = computed(() => solutions.accounting && notSupervisor.value)
const menu = computed(() => buildMenu({ showTrade: showTrade.value, showAcc: showAcc.value, supervisor: solutions.supervisor, can: (p) => org.can(p) }))
function openSection(key: string) { if (route.path !== `/section/${key}`) router.push(`/section/${key}`) }
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

const orgMode = ref<'ecp' | 'manual'>('ecp')
const ecpBusy = ref(false)
async function createOrgEcp() {
  ecpBusy.value = true
  try {
    const created = await org.createByEcp(signChallengeCms, { vatPayer: orgForm.value.vatPayer, taxRegime: orgForm.value.taxRegime })
    ElMessage.success(`Создана организация ${created.name}`)
    orgDialog.value = false
  } catch (e: any) {
    if (e instanceof NcaLayerError && e.code === 'NOT_RUNNING') ElMessage.error({ message: `NCALayer не запущен — запустите его (${NCALAYER_DOWNLOAD})`, duration: 8000 })
    else if (e instanceof NcaLayerError && e.code === 'CANCELED') ElMessage.info('Подпись отменена')
    else ElMessage.error({ message: e?.message || 'Ошибка', duration: 10000 })
  } finally {
    ecpBusy.value = false
  }
}

const collapsed = ref(false)
// Телефон и узкий экран: меню — выезжающая шторка поверх страницы, закрывается после перехода.
const mq = typeof window !== 'undefined' ? window.matchMedia('(max-width: 900px)') : null
const isMobile = ref(!!mq?.matches)
const mobileOpen = ref(false)
mq?.addEventListener?.('change', (e) => { isMobile.value = e.matches; if (!e.matches) mobileOpen.value = false })
watch(() => route.fullPath, () => { mobileOpen.value = false })
const autopilotIssues = ref(0)
// Быстрое создание частых документов (по правам и подпискам организации).
const quick = computed(() => {
  const list: { path: string; title: string; icon: string; color: string; divided?: boolean }[] = []
  const w = org.can('acc.doc.write')
  if (showTrade.value && w) list.push(
    { path: '/accounting/trade/new?type=CUSTOMER_ORDER', title: 'Заказ покупателя', icon: 'Tickets', color: '#1769e0' },
    { path: '/accounting/trade/new?type=INVOICE_OUT', title: 'Счёт покупателю', icon: 'Document', color: '#1769e0' },
    { path: '/accounting/trade/new?type=DEMAND', title: 'Реализация', icon: 'Sell', color: '#23a047' },
    { path: '/accounting/trade/new?type=SUPPLY', title: 'Поступление товара', icon: 'Download', color: '#7c3aed', divided: true },
    { path: '/accounting/trade/new?type=PURCHASE_ORDER', title: 'Заказ поставщику', icon: 'ShoppingCart', color: '#7c3aed' },
    { path: '/accounting/trade/new?type=MOVE', title: 'Перемещение', icon: 'Switch', color: '#0891b2', divided: true },
    { path: '/accounting/trade/new?type=LOSS', title: 'Списание', icon: 'Remove', color: '#dc2626' },
  )
  if (w) list.push(
    { path: '/accounting/documents/new?type=CASH_IN', title: 'Приход в кассу (ПКО)', icon: 'Wallet', color: '#23a047', divided: true },
    { path: '/accounting/documents/new?type=BANK_IN', title: 'Поступление на счёт', icon: 'CreditCard', color: '#23a047' },
  )
  if (org.can('acc.doc.read')) list.push({ path: '/tasks', title: 'Задача', icon: 'Finished', color: '#f59e0b', divided: true })
  return list
})
const taskSum = ref({ open: 0, overdue: 0, today: 0 })
const taskHint = computed(() => (taskSum.value.overdue ? `Просрочено задач: ${taskSum.value.overdue}` : taskSum.value.today ? `Задач на сутки: ${taskSum.value.today}` : `Мои задачи: ${taskSum.value.open}`))
async function loadTasks() { try { taskSum.value = (await api.get('/accounting/tasks/summary')) as any } catch { /* нет прав */ } }
async function loadAutopilotIssues() {
  try { autopilotIssues.value = ((await api.get('/accounting/autopilot/status')) as any).openIssues || 0 } catch { autopilotIssues.value = 0 }
}
const sidebarWidth = computed(() => (isMobile.value ? 260 : collapsed.value ? 64 : 250))
const activeMenu = computed(() => route.path)
const currentTitle = computed(() => (route.name === 'section' ? menu.value.find((x) => x.key === route.params.key)?.title : (route.meta?.title as string)) || '')
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

watch(() => org.currentId, () => { loadAutopilotIssues(); loadTasks(); solutions.load() })
watch(() => route.path, () => { if (route.path === '/tasks') loadTasks() })

onMounted(() => {
  applyTheme()
  org.load()
  solutions.load()
  loadAutopilotIssues()
  loadTasks()
  autopilotTimer = setInterval(() => { loadAutopilotIssues(); loadTasks() }, 60_000)
})
let autopilotTimer: ReturnType<typeof setInterval> | undefined
onBeforeUnmount(() => { clearInterval(autopilotTimer); document.documentElement.classList.remove('dark') })
</script>

<style scoped>
.app-layout { background: var(--fp-bg); }

/* ── Боковое меню: светлое, логотип читается, активный пункт — синяя «пилюля» ── */
.sidebar {
  background: var(--fp-sidebar);
  border-right: 1px solid var(--fp-border);
  display: flex;
  flex-direction: column;
  transition: width .25s;
  overflow: hidden;
}
.sidebar-logo { height: 60px; display: flex; align-items: center; padding: 0 18px; flex-shrink: 0; }
.logo-wordmark { height: 26px; width: auto; display: block; }
.logo-icon-img { height: 28px; width: 28px; display: block; margin-left: -2px; }

.sidebar-menu {
  flex: 1;
  border-right: none;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 10px 12px;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--fp-sidebar-text);
  --el-menu-hover-text-color: var(--fp-text);
  --el-menu-hover-bg-color: var(--fp-sidebar-hover);
  --el-menu-active-color: var(--fp-sidebar-active);
  --el-menu-item-height: 38px;
  --el-menu-sub-item-height: 34px;
  --el-menu-item-font-size: 14px;
  --el-menu-base-level-padding: 12px;
  --el-menu-level-padding: 14px;
  --el-menu-icon-width: 22px;
}
.sidebar-menu :deep(.el-menu-item),
.sidebar-menu :deep(.el-sub-menu__title) { border-radius: 8px; margin: 1px 0; font-weight: 500; }
.sidebar-menu :deep(.el-sub-menu .el-menu-item) { font-weight: 400; font-size: 13.5px; padding-left: 42px !important; min-width: 0; }
.sidebar-menu :deep(.el-menu-item.is-active) { background: var(--fp-sidebar-active-bg); color: var(--fp-sidebar-active); font-weight: 600; }
.sidebar-menu :deep(.el-sub-menu.is-active > .el-sub-menu__title) { color: var(--fp-sidebar-active); }
.sidebar-menu :deep(.el-icon) { color: var(--fp-sidebar-muted); }
.sidebar-menu :deep(.is-active > .el-icon),
.sidebar-menu :deep(.el-sub-menu.is-active > .el-sub-menu__title .el-icon) { color: var(--fp-sidebar-active); }
.sidebar-menu :deep(.el-sub-menu .el-menu) { background: transparent; }
.sidebar-menu.el-menu--collapse { padding: 4px 8px; }

.sidebar-footer { padding: 8px; border-top: 1px solid var(--fp-border-soft); display: flex; justify-content: center; }
.collapse-btn { color: var(--fp-sidebar-muted); }

/* ── Шапка ── */
.app-header {
  background: var(--fp-surface);
  border-bottom: 1px solid var(--fp-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 60px !important;
}
.app-header :deep(.el-breadcrumb) { font-size: 13px; white-space: nowrap; }
.app-header :deep(.el-breadcrumb__inner.is-link) { color: var(--fp-text-3); font-weight: 500; }
.app-header :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) { color: var(--fp-text); font-weight: 600; }
.header-left { display: flex; align-items: center; gap: 18px; min-width: 0; flex: 1; }
.header-search { margin-left: 4px; }
.burger { padding: 6px; margin-left: -8px; }
.header-right { display: flex; align-items: center; gap: 10px; }
.avatar { background: linear-gradient(135deg, #1769e0, #23a047); font-weight: 600; font-size: 13px; }
.sidebar.mobile { position: fixed; top: 0; left: 0; bottom: 0; z-index: 2001; transform: translateX(-100%); transition: transform .25s; }
.sidebar.mobile.open { transform: none; box-shadow: var(--fp-shadow-lg); }
.sidebar-backdrop { position: fixed; inset: 0; background: rgba(15, 20, 27, .35); z-index: 2000; }
@media (max-width: 900px) {
  .app-header { padding: 0 10px; gap: 8px; }
  .header-search { margin-left: 0; }
  .header-right { gap: 6px; }
  .app-main { padding: 12px !important; }
}
@media (max-width: 600px) { .header-right :deep(.el-radio-group), .header-right > .el-button { display: none; } }
.user-info { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--fp-text-2); padding: 4px 6px; border-radius: 8px; }
.user-info:hover { background: var(--fp-sidebar-hover); }
.user-name { font-size: 14px; font-weight: 500; color: var(--fp-text); }
.org-select { width: 230px; }
@media (max-width: 900px) { .org-select { width: 120px; } .user-info :deep(.el-icon) { display: none; } }

.app-main { background: var(--fp-bg); padding: 24px 28px; overflow-y: auto; }
.app-main > :deep(*) { max-width: 1600px; margin-left: auto; margin-right: auto; }
.sec-title { flex: 1; }
.ecp-hint { margin: 0 0 16px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.5; }
.sub-ic { font-size: 15px !important; margin-right: 8px !important; width: 16px !important; }
.sidebar-menu :deep(.el-sub-menu .el-menu-item) { padding-left: 38px !important; }
.sub-title { overflow: hidden; text-overflow: ellipsis; }
.quick-btn { font-weight: 600; }
.bell :deep(.el-badge__content) { top: 6px; right: 8px; }
:global(.quick-menu .el-dropdown-menu__item) { gap: 4px; padding: 7px 16px; }
@media (max-width: 900px) { .quick-btn { padding: 8px; } .quick-btn :deep(span:not(.el-icon)) { display: none; } }
:global(.el-dropdown-menu__item.is-on) { color: var(--el-color-primary); font-weight: 600; }
</style>
