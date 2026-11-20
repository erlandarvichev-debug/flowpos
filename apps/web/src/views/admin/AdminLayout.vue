<template>
  <!-- Панель управления платформой (ad.flowpos.kz) -->
  <div class="shell">
    <aside class="side" :class="{ open: menuOpen }">
      <div class="brand">
        <img src="/brand/flowpos-wordmark.png" alt="FlowPOS" />
        <span>Управление</span>
      </div>
      <nav>
        <router-link v-for="i in items" :key="i.to" :to="i.to" class="item" :class="{ active: isActive(i.to) }" @click="menuOpen = false">
          <el-icon><component :is="i.icon" /></el-icon>{{ i.title }}
        </router-link>
      </nav>
      <div class="side-foot">
        <a :href="appHref" class="item ext"><el-icon><Link /></el-icon>{{ appHost }} ↗</a>
      </div>
    </aside>
    <div class="main">
      <header class="top">
        <el-button class="burger" text @click="menuOpen = !menuOpen"><el-icon size="20"><Menu /></el-icon></el-button>
        <h1>{{ String(route.meta.title || '') }}</h1>
        <div class="me">
          <span class="email">{{ auth.user?.email }}</span>
          <el-button size="small" @click="logout">Выйти</el-button>
        </div>
      </header>
      <main class="content"><router-view /></main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAdminStore } from '@/stores/admin'
import { appUrl } from '@/utils/host'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const admin = useAdminStore()
const menuOpen = ref(false)
const appHref = appUrl()
const appHost = appHref.replace(/^https?:\/\//, '').replace(/\/$/, '')
const items = [
  { to: '/', title: 'Обзор', icon: 'Odometer' },
  { to: '/organizations', title: 'Организации и подписки', icon: 'OfficeBuilding' },
  { to: '/users', title: 'Пользователи', icon: 'User' },
  { to: '/journal', title: 'Журнал', icon: 'Document' },
]
const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to))
async function logout() { await auth.logout(); admin.reset(); router.push('/login') }
</script>

<style scoped>
.shell { display: flex; min-height: 100vh; background: #f4f6f9; }
.side { width: 236px; flex: none; background: #0b1220; color: #cbd5e1; display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; align-items: center; gap: 10px; padding: 20px 18px 18px; border-bottom: 1px solid rgba(255, 255, 255, .06); }
.brand img { width: 104px; filter: brightness(0) invert(1); }
.brand span { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #5eead4; }
nav { padding: 12px 10px; display: flex; flex-direction: column; gap: 2px; flex: 1; }
.item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; color: #cbd5e1; text-decoration: none; font-size: 14px; }
.item:hover { background: rgba(255, 255, 255, .06); color: #fff; }
.item.active { background: #0f766e; color: #fff; }
.side-foot { padding: 10px; border-top: 1px solid rgba(255, 255, 255, .06); }
.ext { font-size: 13px; color: #94a3b8; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.top { display: flex; align-items: center; gap: 12px; padding: 14px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; z-index: 5; }
.top h1 { font-size: 18px; margin: 0; flex: 1; color: #1f2937; }
.me { display: flex; align-items: center; gap: 10px; }
.email { color: #6b7280; font-size: 13px; }
.burger { display: none; }
.content { padding: 20px 24px 40px; }
@media (max-width: 860px) {
  .side { position: fixed; left: 0; top: 0; z-index: 20; transform: translateX(-100%); transition: transform .2s; }
  .side.open { transform: none; box-shadow: 0 0 40px rgba(0, 0, 0, .4); }
  .burger { display: inline-flex; }
  .email { display: none; }
  .top { padding: 10px 16px; }
  .content { padding: 16px; }
}
</style>
