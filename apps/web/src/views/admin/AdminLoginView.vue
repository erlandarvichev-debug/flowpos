<template>
  <!-- Вход в панель управления платформой (ad.flowpos.kz). Учётная запись та же, что на flowpos.kz. -->
  <div class="page">
    <div class="card">
      <img src="/brand/flowpos-wordmark.png" alt="FlowPOS" class="logo" />
      <div class="badge">Управление платформой</div>

      <el-form v-if="!mfaToken" :model="form" @submit.prevent="login">
        <el-form-item><el-input v-model="form.email" placeholder="Email" size="large" autocomplete="username" :prefix-icon="User" /></el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="Пароль" size="large" autocomplete="current-password" show-password :prefix-icon="Lock" @keyup.enter="login" />
        </el-form-item>
        <el-button type="primary" size="large" class="wide" :loading="busy" @click="login">Войти</el-button>
      </el-form>

      <el-form v-else @submit.prevent="loginMfa">
        <p class="hint">Введите код из приложения-аутентификатора или код восстановления.</p>
        <el-form-item><el-input v-model="code" placeholder="Код" size="large" autocomplete="one-time-code" maxlength="20" @keyup.enter="loginMfa" /></el-form-item>
        <el-button type="primary" size="large" class="wide" :loading="busy" @click="loginMfa">Подтвердить</el-button>
        <el-button link class="wide back" @click="mfaToken = ''">Назад</el-button>
      </el-form>

      <p class="foot">Только для администраторов платформы. Рабочее место клиентов — <a :href="appHref">{{ appHost }}</a></p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Lock, User } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useAdminStore } from '@/stores/admin'
import { appUrl } from '@/utils/host'

const router = useRouter()
const auth = useAuthStore()
const admin = useAdminStore()
const form = ref({ email: '', password: '' })
const code = ref('')
const mfaToken = ref('')
const busy = ref(false)
const appHref = appUrl()
const appHost = appHref.replace(/^https?:\/\//, '').replace(/\/$/, '')

async function finish(res: any) {
  auth.token = res.accessToken
  auth.user = res.user
  localStorage.setItem('fp_token', res.accessToken)
  admin.reset()
  router.push((await admin.check()) ? '/' : '/no-access')
}

async function login() {
  if (!form.value.email || !form.value.password) return ElMessage.warning('Введите email и пароль')
  busy.value = true
  try {
    const res: any = await api.post('/auth/login', { email: form.value.email.trim(), password: form.value.password })
    if (res.mfaRequired) { mfaToken.value = res.mfaToken; code.value = '' } else await finish(res)
  } catch (e: any) {
    ElMessage.error(e?.message || 'Неверный логин или пароль')
  }
  busy.value = false
}

async function loginMfa() {
  if (!code.value.trim()) return
  busy.value = true
  try { await finish(await api.post('/auth/mfa/login', { mfaToken: mfaToken.value, code: code.value.trim() })) } catch (e: any) { ElMessage.error(e?.message || 'Неверный код') }
  busy.value = false
}
</script>

<style scoped>
.page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: radial-gradient(1200px 600px at 20% 0%, #134e4a 0%, transparent 60%), #0b1220; }
.card { width: 400px; max-width: 100%; background: #fff; border-radius: 14px; padding: 36px 32px 24px; box-shadow: 0 24px 70px rgba(0, 0, 0, .45); }
.logo { width: 190px; display: block; margin: 0 auto 10px; }
.badge { text-align: center; margin: 0 auto 26px; font-size: 13px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #0f766e; }
.wide { width: 100%; }
.back { margin: 8px 0 0 !important; }
.hint { color: #606266; font-size: 13px; margin: 0 0 12px; }
.foot { margin: 22px 0 0; text-align: center; color: #909399; font-size: 12px; }
.foot a { color: #0f766e; }
</style>
