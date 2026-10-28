import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/api/client'

function readOrg(): string | null {
  try { return localStorage.getItem('fp_org') } catch { return null }
}

export const useOrgStore = defineStore('org', () => {
  const organizations = ref<any[]>([])
  const currentId = ref<string | null>(readOrg())
  const context = ref<{ organizationId: string; role: string; permissions: string[] } | null>(null)

  const current = computed(() => organizations.value.find((o) => o.id === currentId.value) || null)

  async function load() {
    try {
      organizations.value = (await api.get('/accounting/organizations/mine')) as any
    } catch { organizations.value = [] }
    await loadContext()
  }

  async function loadContext() {
    try {
      context.value = (await api.get('/accounting/context')) as any
      if (context.value && !currentId.value) currentId.value = context.value.organizationId
    } catch { context.value = null }
  }

  async function select(id: string) {
    currentId.value = id
    try { localStorage.setItem('fp_org', id) } catch { /* ignore */ }
    await load()
  }

  async function create(data: any) {
    const org = (await api.post('/accounting/organizations', data)) as any
    await select(org.id)
    return org
  }

  function can(perm: string) {
    return context.value?.permissions?.includes(perm) ?? false
  }

  return { organizations, currentId, current, context, load, loadContext, select, create, can }
})
