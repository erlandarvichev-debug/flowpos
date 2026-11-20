import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api/client'

/** Панель управления: пускать ли вошедшего (администратор платформы). Решает сервер — здесь только подсказка экрану. */
export const useAdminStore = defineStore('admin', () => {
  const isAdmin = ref<boolean | null>(null)

  async function check(): Promise<boolean> {
    if (isAdmin.value !== null) return isAdmin.value
    try { isAdmin.value = !!((await api.get('/subscriptions/platform-admin')) as any)?.isPlatformAdmin } catch { isAdmin.value = false }
    return isAdmin.value
  }

  function reset() { isAdmin.value = null }

  return { isAdmin, check, reset }
})
