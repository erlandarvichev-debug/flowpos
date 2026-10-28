<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <span class="logo">⚡</span>
        <h1>FlowPOS</h1>
        <p>Платформа управления торговлей и персоналом</p>
      </div>

      <el-form :model="form" :rules="rules" ref="formRef" @submit.prevent="handleLogin">
        <el-form-item prop="email">
          <el-input
            v-model="form.email"
            placeholder="Email"
            size="large"
            :prefix-icon="User"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="Пароль"
            size="large"
            :prefix-icon="Lock"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-button
          type="primary"
          size="large"
          style="width: 100%"
          :loading="loading"
          @click="handleLogin"
        >
          Войти
        </el-button>
      </el-form>

      <div class="login-hint" v-if="isDev">
        <el-text type="info" size="small">Demo: admin@flowpos.kz / admin123</el-text>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { User, Lock } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const formRef = ref()
const loading = ref(false)
const isDev = (import.meta as any).env?.DEV

const form = ref({ email: '', password: '' })
const rules = {
  email: [{ required: true, type: 'email' as const, message: 'Введите email', trigger: 'blur' }],
  password: [{ required: true, min: 6, message: 'Минимум 6 символов', trigger: 'blur' }],
}

async function handleLogin() {
  await formRef.value?.validate(async (valid: boolean) => {
    if (!valid) return
    loading.value = true
    try {
      await auth.login(form.value.email, form.value.password)
      router.push('/dashboard')
    } catch (err: any) {
      ElMessage.error(err?.message || 'Неверный логин или пароль')
    } finally {
      loading.value = false
    }
  })
}
</script>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #001529 0%, #003366 100%);
}

.login-card {
  background: #fff;
  border-radius: 12px;
  padding: 48px 40px 32px;
  width: 420px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}

.login-header {
  text-align: center;
  margin-bottom: 32px;
}

.logo {
  font-size: 48px;
  display: block;
  margin-bottom: 8px;
}

h1 {
  font-size: 28px;
  font-weight: 700;
  color: #303133;
  margin-bottom: 4px;
}

.login-header p {
  color: #909399;
  font-size: 14px;
}

.login-hint {
  text-align: center;
  margin-top: 16px;
}
</style>
