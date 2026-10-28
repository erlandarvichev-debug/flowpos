<template>
  <div>
    <div class="page-header">
      <h1>Пользователи</h1>
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить пользователя</el-button>
    </div>
    <el-card>
      <el-table :data="users" v-loading="loading">
        <el-table-column label="ФИО" min-width="200">
          <template #default="{ row }">{{ row.lastName }} {{ row.firstName }}</template>
        </el-table-column>
        <el-table-column prop="email" label="Email" />
        <el-table-column label="Роли">
          <template #default="{ row }">
            <el-tag v-for="ur in row.userRoles" :key="ur.roleId" size="small" style="margin-right: 4px;">
              {{ ur.role?.displayName }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Статус" width="100">
          <template #default="{ row }">
            <el-tag :type="row.isActive ? 'success' : 'danger'" size="small">
              {{ row.isActive ? 'Активен' : 'Отключён' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="" width="80">
          <template #default="{ row }">
            <el-button text :icon="Edit" size="small" @click="openForm(row)" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="formVisible" :title="editItem ? 'Редактировать' : 'Новый пользователь'" width="480px">
      <el-form :model="form" label-width="110px">
        <el-form-item label="Фамилия"><el-input v-model="form.lastName" /></el-form-item>
        <el-form-item label="Имя"><el-input v-model="form.firstName" /></el-form-item>
        <el-form-item label="Email"><el-input v-model="form.email" type="email" /></el-form-item>
        <el-form-item :label="editItem ? 'Новый пароль' : 'Пароль'">
          <el-input v-model="form.password" type="password" show-password :placeholder="editItem ? 'Оставьте пустым' : ''" />
        </el-form-item>
        <el-form-item label="Роли">
          <el-checkbox-group v-model="form.roleIds">
            <el-checkbox v-for="r in roles" :key="r.id" :label="r.id">{{ r.displayName }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">Отмена</el-button>
        <el-button type="primary" @click="save" :loading="saving">Сохранить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'

const loading = ref(false)
const saving = ref(false)
const users = ref<any[]>([])
const roles = ref<any[]>([])
const formVisible = ref(false)
const editItem = ref<any>(null)
const form = ref<any>({})

async function load() {
  loading.value = true
  const [u, r] = await Promise.all([api.get('/users'), api.get('/roles')]) as any[]
  users.value = u
  roles.value = r
  loading.value = false
}

function openForm(item?: any) {
  editItem.value = item || null
  form.value = item
    ? { lastName: item.lastName, firstName: item.firstName, email: item.email, password: '', roleIds: item.userRoles?.map((ur: any) => ur.roleId) || [] }
    : { lastName: '', firstName: '', email: '', password: '', roleIds: [] }
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    if (editItem.value) {
      await api.put(`/users/${editItem.value.id}`, form.value)
    } else {
      await api.post('/users', form.value)
    }
    ElMessage.success('Сохранено')
    formVisible.value = false
    await load()
  } catch (e: any) { ElMessage.error(e?.message || 'Ошибка') }
  saving.value = false
}

onMounted(load)
</script>
