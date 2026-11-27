import { computed, ref } from 'vue'

/** Тема оформления: светлая, тёмная или как в системе. Выбор хранится в браузере (fp_theme). */
export type ThemeMode = 'light' | 'dark' | 'system'

const KEY = 'fp_theme'
const read = (): ThemeMode => {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system' } catch { return 'system' }
}
const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const mode = ref<ThemeMode>(read())
const systemDark = ref(!!mq?.matches)
mq?.addEventListener?.('change', (e) => { systemDark.value = e.matches; apply() })

const isDark = computed(() => (mode.value === 'system' ? systemDark.value : mode.value === 'dark'))

/** Класс `dark` на <html> включает тёмные переменные Element Plus и темы FlowPOS (assets/theme.css). */
export function apply() {
  if (typeof document === 'undefined') return
  const dark = mode.value === 'system' ? !!mq?.matches : mode.value === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export function useTheme() {
  const setMode = (m: ThemeMode) => {
    mode.value = m
    try { if (m === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, m) } catch { /* без хранилища — до перезагрузки */ }
    apply()
  }
  /** Быстрый переключатель: светлая ↔ тёмная. */
  const toggle = () => setMode(isDark.value ? 'light' : 'dark')
  return { mode, isDark, setMode, toggle }
}
