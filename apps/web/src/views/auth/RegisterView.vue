<template>
  <!-- Регистрация компании: компания + владелец, сразу вход. «Учётная система» и «Бухгалтерия» включены. -->
  <div class="page">
    <div class="card">
      <router-link to="/welcome"><img src="/brand/flowpos-wordmark.png" alt="FlowPOS" class="logo" /></router-link>
      <h1>Регистрация компании</h1>
      <p class="sub">Учёт и бухгалтерия включатся сразу. «Супервайзер» для торговых представителей подключим по заявке.</p>

      <el-form ref="formRef" :model="f" :rules="rules" label-position="top" @submit.prevent="submit">
        <div class="row">
          <el-form-item label="Название компании" prop="company" class="grow"><el-input v-model="f.company" placeholder="ТОО «Ромашка»" autocomplete="organization" /></el-form-item>
          <el-form-item label="Форма" class="form">
            <el-select v-model="f.legalForm">
              <el-option label="ТОО" value="TOO" /><el-option label="ИП" value="IP" /><el-option label="АО" value="AO" /><el-option label="Другое" value="OTHER" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item :label="f.legalForm === 'IP' ? 'ИИН' : 'БИН'" prop="bin"><el-input v-model="f.bin" maxlength="12" inputmode="numeric" placeholder="12 цифр" /></el-form-item>
        <div class="row">
          <el-form-item label="Имя" prop="firstName" class="grow"><el-input v-model="f.firstName" autocomplete="given-name" /></el-form-item>
          <el-form-item label="Фамилия" prop="lastName" class="grow"><el-input v-model="f.lastName" autocomplete="family-name" /></el-form-item>
        </div>
        <div class="row">
          <el-form-item label="E-mail (логин)" prop="email" class="grow"><el-input v-model="f.email" type="email" autocomplete="email" /></el-form-item>
          <el-form-item label="Телефон" class="grow"><el-input v-model="f.phone" autocomplete="tel" placeholder="+7 7__ ___ __ __" /></el-form-item>
        </div>
        <el-form-item label="Пароль" prop="password"><el-input v-model="f.password" type="password" show-password autocomplete="new-password" placeholder="не короче 8 символов, буквы и цифры" /></el-form-item>
        <!-- ловушка для ботов: человек это поле не видит -->
        <input v-model="f.website" class="trap" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <el-form-item prop="agree">
          <el-checkbox v-model="f.agree">Я — представитель компании и вправе её зарегистрировать</el-checkbox>
        </el-form-item>
        <el-button type="primary" size="large" class="wide" :loading="busy" native-type="submit">Зарегистрировать</el-button>
      </el-form>
      <p class="foot">Уже есть учётная запись? <router-link to="/login">Войти</router-link></p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const formRef = ref()
const busy = ref(false)
const f = ref({ company: '', legalForm: 'TOO', bin: '', firstName: '', lastName: '', email: '', phone: '', password: '', website: '', agree: false })

const rules = {
  company: [{ required: true, min: 2, message: 'Укажите название', trigger: 'blur' }],
  bin: [{ required: true, pattern: /^\d{12}$/, message: '12 цифр', trigger: 'blur' }],
  firstName: [{ required: true, message: 'Укажите имя', trigger: 'blur' }],
  lastName: [{ required: true, message: 'Укажите фамилию', trigger: 'blur' }],
  email: [{ required: true, type: 'email' as const, message: 'Неверный e-mail', trigger: 'blur' }],
  password: [{ required: true, validator: (_: any, v: string, cb: any) => (v && v.length >= 8 && /\d/.test(v) && /[A-Za-zА-Яа-яЁё]/.test(v) ? cb() : cb(new Error('Не короче 8 символов, буквы и цифры'))), trigger: 'blur' }],
  agree: [{ validator: (_: any, v: boolean, cb: any) => (v ? cb() : cb(new Error('Подтвердите'))), trigger: 'change' }],
}

async function submit() {
  if (busy.value) return
  const ok = await formRef.value?.validate().catch(() => false)
  if (!ok) return
  busy.value = true
  try {
    const { agree, ...body } = f.value
    const res: any = await api.post('/auth/register', { ...body, bin: body.bin.replace(/\s/g, '') })
    if (res?.accessToken) {
      auth.token = res.accessToken
      auth.user = res.user
      localStorage.setItem('fp_token', res.accessToken)
      ElMessage.success('Компания зарегистрирована. Добро пожаловать в FlowPOS!')
      router.push('/dashboard')
    } else {
      router.push('/login')
    }
  } catch (e: any) {
    ElMessage.error(e?.message || 'Не удалось зарегистрировать')
  }
  busy.value = false
}
</script>

<style scoped>
.page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; background: linear-gradient(135deg, #001529 0%, #003366 100%); }
.card { width: 560px; max-width: 100%; background: #fff; border-radius: 14px; padding: 32px 32px 22px; box-shadow: 0 20px 60px rgba(0, 0, 0, .3); }
.logo { width: 170px; display: block; margin: 0 auto 14px; }
h1 { text-align: center; font-size: 22px; margin: 0 0 6px; color: #1f2937; }
.sub { text-align: center; color: #6b7280; font-size: 13px; margin: 0 0 20px; }
.row { display: flex; gap: 12px; }
.grow { flex: 1; min-width: 0; }
.form { width: 120px; }
.wide { width: 100%; }
.trap { position: absolute; left: -10000px; width: 1px; height: 1px; opacity: 0; }
.foot { text-align: center; color: #909399; font-size: 13px; margin: 16px 0 0; }
.foot a { color: #0f766e; }
@media (max-width: 520px) { .row { flex-direction: column; gap: 0; } .form { width: 100%; } .card { padding: 24px 18px 18px; } }
</style>
