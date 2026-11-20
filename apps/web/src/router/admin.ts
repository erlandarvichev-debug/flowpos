// Панель управления платформой (ad.flowpos.kz): свои адреса, свой вход, только администраторы платформы.
import type { RouteLocationNormalized, RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAdminStore } from '@/stores/admin'

export const adminRoutes: RouteRecordRaw[] = [
  { path: '/login', name: 'admin-login', component: () => import('@/views/admin/AdminLoginView.vue'), meta: { public: true } },
  { path: '/no-access', name: 'admin-no-access', component: () => import('@/views/admin/AdminNoAccessView.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/views/admin/AdminLayout.vue'),
    children: [
      { path: '', name: 'admin-overview', component: () => import('@/views/admin/OverviewView.vue'), meta: { title: 'Обзор' } },
      { path: 'organizations', name: 'admin-organizations', component: () => import('@/views/admin/OrganizationsView.vue'), meta: { title: 'Организации' } },
      { path: 'organizations/:id', name: 'admin-organization', component: () => import('@/views/admin/OrganizationView.vue'), meta: { title: 'Организация' } },
      { path: 'users', name: 'admin-users', component: () => import('@/views/admin/UsersView.vue'), meta: { title: 'Пользователи' } },
      { path: 'journal', name: 'admin-journal', component: () => import('@/views/admin/JournalView.vue'), meta: { title: 'Журнал' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export async function adminGuard(to: RouteLocationNormalized) {
  document.title = to.meta.title ? `${String(to.meta.title)} · FlowPOS — управление` : 'FlowPOS — управление'
  if (to.meta.public) return true
  const auth = useAuthStore()
  if (!auth.token) return '/login'
  if (!auth.user) {
    await auth.fetchMe()
    if (!auth.user) return '/login'
  }
  const admin = useAdminStore()
  if (!(await admin.check())) return '/no-access'
  return true
}
