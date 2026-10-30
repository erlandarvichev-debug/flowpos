import axios from 'axios'

export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true, // нужно для httpOnly cookie с refresh token
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  // FP-022: код трассировки действия — сервер пишет его в журнал и логи, а при ошибке пользователь видит его
  // в сообщении и может назвать поддержке.
  if (!config.headers['X-Request-Id']) config.headers['X-Request-Id'] = newRequestId()
  const token = localStorage.getItem('fp_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  try {
    const org = localStorage.getItem('fp_org')
    if (org && !config.headers['X-Organization-Id']) config.headers['X-Organization-Id'] = org
  } catch { /* storage недоступен */ }
  return config
})

function newRequestId() {
  return globalThis.crypto && 'randomUUID' in globalThis.crypto
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

let refreshing: Promise<string | null> | null = null

api.interceptors.response.use(
  (res) => res.data,
  async (err) => {
    const original = err.config
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true
      // Пробуем обновить токен через httpOnly cookie
      if (!refreshing) {
        refreshing = axios
          .post('/api/v1/auth/refresh', {}, { withCredentials: true })
          .then((r) => {
            const token = r.data?.accessToken
            if (token) localStorage.setItem('fp_token', token)
            return token
          })
          .catch(() => null)
          .finally(() => { refreshing = null })
      }
      const newToken = await refreshing
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`
        return api(original)
      }
      // refresh не помог — выходим
      localStorage.removeItem('fp_token')
      window.location.href = '/login'
    }
    const data = err.response?.data
    const traceId = err.response?.headers?.['x-request-id'] || original?.headers?.['X-Request-Id']
    if (data && typeof data === 'object' && traceId && !data.traceId) data.traceId = traceId
    return Promise.reject(data || err)
  },
)

export default api
