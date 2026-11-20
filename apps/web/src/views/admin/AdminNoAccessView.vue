<template>
  <div class="page">
    <el-result icon="warning" title="Нет доступа к управлению платформой" :sub-title="`Вы вошли как ${email || '—'}. Этот адрес — только для администраторов платформы.`">
      <template #extra>
        <el-button type="primary" @click="go">Перейти на {{ appHost }}</el-button>
        <el-button @click="logout">Войти другим пользователем</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useAdminStore } from '@/stores/admin'
import { appUrl } from '@/utils/host'

const router = useRouter()
const auth = useAuthStore()
const admin = useAdminStore()
const email = computed(() => auth.user?.email)
const appHref = appUrl()
const appHost = appHref.replace(/^https?:\/\//, '').replace(/\/$/, '')
function go() { window.location.href = appHref }
async function logout() { await auth.logout(); admin.reset(); router.push('/login') }
</script>

<style scoped>
.page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
</style>
