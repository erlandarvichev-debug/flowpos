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
        background-color="#001529"
        text-color="#a6adb4"
        active-text-color="#ffffff"
      >
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <template #title>Главное</template>
        </el-menu-item>

        <!-- Разделы — из components/layout/menu.ts (тот же список показывают страницы-плитки /section/<ключ>).
             Нажатие на заголовок раздела открывает его страницу с плитками. -->
        <el-sub-menu v-for="sec in menu" :key="sec.key" :index="sec.key">
          <template #title>
            <el-icon><component :is="sec.icon" /></el-icon>
            <span class="sec-title" @click="openSection(sec.key)">{{ sec.title }}</span>
          </template>
          <el-menu-item v-for="it in sec.items" :key="it.path" :index="it.path">
            {{ it.title }}
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
          <el-button v-if="isMobile" text class="burger" @click="mobileOpen = true"><el-icon :size="20"><Menu /></el-icon></el-button>
          <el-breadcrumb v-if="!isMobile" separator="/">
            <el-breadcrumb-item :to="{ path: '/dashboard' }">FlowPOS</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
          <GlobalSearch class="header-search" />
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
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { signChallengeCms, NcaLayerError, NCALAYER_DOWNLOAD } from '@/utils/ncalayer'
import { buildMenu } from './menu'
import GlobalSearch from './GlobalSearch.vue'
import { Menu } from '@element-plus/icons-vue'

const route = useRoute()
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
async function loadAutopilotIssues() {
  try { autopilotIssues.value = ((await api.get('/accounting/autopilot/status')) as any).openIssues || 0 } catch { autopilotIssues.value = 0 }
}
const sidebarWidth = computed(() => (isMobile.value ? 240 : collapsed.value ? 64 : 220))
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

watch(() => org.currentId, () => { loadAutopilotIssues(); solutions.load() })

onMounted(() => {
  org.load()
  solutions.load()
  loadAutopilotIssues()
  autopilotTimer = setInterval(() => loadAutopilotIssues(), 60_000)
})
let autopilotTimer: ReturnType<typeof setInterval> | undefined
onBeforeUnmount(() => clearInterval(autopilotTimer))
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
.logo-wordmark { height: 30px; width: auto; display: block; }
.logo-icon-img { height: 28px; width: 28px; display: block; }
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

.header-left { display: flex; align-items: center; gap: 16px; min-width: 0; flex: 1; }
.header-search { margin-left: 8px; }
.burger { padding: 6px; margin-left: -8px; }
.header-right { display: flex; align-items: center; gap: 12px; }
.sidebar.mobile { position: fixed; top: 0; left: 0; bottom: 0; z-index: 2001; transform: translateX(-100%); transition: transform .25s; }
.sidebar.mobile.open { transform: none; box-shadow: 4px 0 24px rgba(0,0,0,.25); }
.sidebar-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 2000; }
@media (max-width: 900px) {
  .app-header { padding: 0 10px; gap: 8px; }
  .header-search { margin-left: 0; }
  .header-right { gap: 6px; }
  .app-main { padding: 12px; }
}
@media (max-width: 600px) { .header-right :deep(.el-radio-group), .header-right > .el-button { display: none; } }
.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #606266;
}
.user-name { font-size: 14px; }
.org-select { width: 220px; }
@media (max-width: 900px) { .org-select { width: 120px; } .user-info :deep(.el-icon) { display: none; } }

.app-main {
  background: #f5f7fa;
  padding: 20px;
  overflow-y: auto;
}
.sec-title { flex: 1; }
.ecp-hint { margin: 0 0 16px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.5; }
</style>
