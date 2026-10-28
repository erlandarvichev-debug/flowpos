import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/api/client'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<any>(null)
  const token = ref<string | null>(localStorage.getItem('fp_token'))

  const isLoggedIn = computed(() => !!token.value && !!user.value)

  async function login(email: string, password: string) {
    const res = await api.post('/auth/login', { email, password }) as any
    token.value = res.accessToken
    user.value = res.user
    localStorage.setItem('fp_token', res.accessToken)
    return res
  }

  async function fetchMe() {
    if (!token.value) return
    try {
      const res = await api.get('/auth/me') as any
      user.value = res
    } catch {
      logout()
    }
  }

  async function logout() {
    try { await api.post('/auth/logout') } catch { /* silent */ }
    user.value = null
    token.value = null
    localStorage.removeItem('fp_token')
  }

  function hasRole(role: string) {
    return user.value?.roles?.includes(role) ?? false
  }

  function hasPermission(perm: string) {
    return user.value?.permissions?.includes(perm) ?? false
  }

  return { user, token, isLoggedIn, login, logout, fetchMe, hasRole, hasPermission }
})
