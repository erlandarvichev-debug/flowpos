import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api/client'

interface SolutionState { enabled: boolean; status: string; validUntil: string | null; seats: number | null; reason?: string }

/**
 * Подписки организации на решения платформы и признак администратора платформы — для меню.
 * Ошибка чтения не прячет учёт и бухгалтерию: меню остаётся как было до подписок.
 */
export const useSolutionsStore = defineStore('solutions', () => {
  const states = ref<Record<string, SolutionState>>({})
  const isPlatformAdmin = ref(false)
  const loaded = ref(false)

  const trade = computed(() => states.value.trade?.enabled ?? true)
  const accounting = computed(() => states.value.accounting?.enabled ?? true)
  const supervisor = computed(() => states.value.supervisor?.enabled ?? false)

  async function load() {
    try { states.value = (await api.get('/subscriptions/mine')) as any } catch { states.value = {} }
    try { isPlatformAdmin.value = !!((await api.get('/subscriptions/platform-admin')) as any)?.isPlatformAdmin } catch { isPlatformAdmin.value = false }
    loaded.value = true
  }

  return { states, isPlatformAdmin, loaded, trade, accounting, supervisor, load }
})
