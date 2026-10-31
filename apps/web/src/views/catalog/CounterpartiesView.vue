<template>
  <div>
    <div class="page-header">
      <h1>Контрагенты</h1>
      <el-button type="primary" :icon="Plus" @click="openForm()">Добавить</el-button>
    </div>

    <el-card>
      <el-row :gutter="12" style="margin-bottom: 16px;">
        <el-col :span="10">
          <el-input v-model="search" placeholder="Название, ИИН/БИН, телефон..." :prefix-icon="Search" clearable @input="debouncedLoad" />
        </el-col>
        <el-col :span="6">
          <el-select v-model="typeFilter" placeholder="Тип" clearable @change="loadList">
            <el-option label="Покупатели" value="CUSTOMER" />
            <el-option label="Поставщики" value="SUPPLIER" />
            <el-option label="Оба" value="BOTH" />
          </el-select>
        </el-col>
      </el-row>

      <el-table :data="list" v-loading="loading" @row-click="(r: any) => router.push(`/catalog/counterparties/${r.id}`)" style="cursor: pointer;">
        <el-table-column label="Наименование" min-width="220">
          <template #default="{ row }">
            {{ row.name }}
            <el-tag v-if="row.kind && row.kind !== 'LEGAL'" size="small" effect="plain">{{ kindLabels[row.kind] }}</el-tag>
            <el-tag v-if="row.organizationId" size="small" type="info" effect="plain">личный</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Тип" width="120">
          <template #default="{ row }">
            <el-tag :type="row.type === 'CUSTOMER' ? 'success' : row.type === 'SUPPLIER' ? 'warning' : 'info'" size="small">
              {{ typeLabels[row.type] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="inn" label="ИИН/БИН" width="140" />
        <el-table-column prop="phone" label="Телефон" />
        <el-table-column prop="email" label="Email" />
        <el-table-column label="" width="80">
          <template #default="{ row }">
            <el-button size="small" text :icon="Edit" aria-label="Редактировать" @click.stop="openForm(row)" />
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        style="margin-top: 16px;"
        v-model:current-page="page"
        :page-size="50"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="loadList"
      />
    </el-card>

    <el-dialog v-model="formVisible" :title="editItem ? 'Редактировать' : 'Новый контрагент'" width="560px">
      <el-form :model="form" label-width="130px">
        <el-form-item label="Наименование" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="Полное"><el-input v-model="form.fullName" placeholder="ТОО «…» — как в документах" /></el-form-item>
        <el-form-item label="Вид">
          <el-select v-model="form.kind" @change="onKind">
            <el-option v-for="(l, k) in kindLabels" :key="k" :label="l" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="Роль">
          <el-select v-model="form.type">
            <el-option label="Покупатель" value="CUSTOMER" />
            <el-option label="Поставщик" value="SUPPLIER" />
            <el-option label="Покупатель и поставщик" value="BOTH" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.kind === 'NONRESIDENT'" label="Страна">
          <el-input v-model="form.countryCode" maxlength="2" placeholder="CN, RU, US…" style="width: 100px;" />
        </el-form-item>
        <el-form-item :label="form.kind === 'NONRESIDENT' ? 'Налоговый номер' : 'ИИН/БИН'"><el-input v-model="form.inn" :maxlength="form.kind === 'NONRESIDENT' ? 40 : 12" /></el-form-item>
        <el-form-item label="КБе"><el-input v-model="form.kbe" maxlength="2" placeholder="17" style="width: 100px;" /></el-form-item>
        <el-form-item label="Телефон"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="Email"><el-input v-model="form.email" /></el-form-item>
        <el-form-item v-if="!editItem"><el-checkbox v-model="form.own">Личный — только для этой организации</el-checkbox></el-form-item>
        <div v-if="!editItem" class="hint">Адрес, банковские счета и договоры — в карточке контрагента после сохранения.</div>
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
import { Plus, Search, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'

const loading = ref(false)
const saving = ref(false)
const list = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const search = ref('')
const typeFilter = ref('')
const formVisible = ref(false)
const editItem = ref<any>(null)
const form = ref<any>({})
const typeLabels: Record<string, string> = { CUSTOMER: 'Покупатель', SUPPLIER: 'Поставщик', BOTH: 'Оба' }
const kindLabels: Record<string, string> = { LEGAL: 'Юрлицо', ENTREPRENEUR: 'ИП', INDIVIDUAL: 'Физлицо', NONRESIDENT: 'Нерезидент' }
const router = useRouter()
const org = useOrgStore()
function onKind(k: string) {
  if (k !== 'NONRESIDENT') form.value.countryCode = 'KZ'
  else if (form.value.countryCode === 'KZ') form.value.countryCode = ''
}

let debounceTimer: ReturnType<typeof setTimeout>
function debouncedLoad() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { page.value = 1; loadList() }, 400)
}

async function loadList() {
  loading.value = true
  const res = await api.get('/catalog/counterparties', {
    params: { search: search.value || undefined, type: typeFilter.value || undefined, page: page.value },
  }) as any
  list.value = res.items ?? res.counterparties ?? res.data ?? []
  total.value = res.total ?? 0
  loading.value = false
}

function openForm(item?: any) {
  editItem.value = item || null
  // FP-026: поля API (адреса — в карточке, с датами действия).
  form.value = item
    ? { name: item.name, fullName: item.fullName, kind: item.kind ?? 'LEGAL', type: item.type, inn: item.inn, kbe: item.kbe, countryCode: item.countryCode ?? 'KZ', phone: item.phone, email: item.email }
    : { name: '', fullName: '', kind: 'LEGAL', type: 'CUSTOMER', inn: '', kbe: '', countryCode: 'KZ', phone: '', email: '', own: false }
  formVisible.value = true
}

async function save() {
  saving.value = true
  try {
    const { own, ...body } = form.value
    if (editItem.value) {
      await api.put(`/catalog/counterparties/${editItem.value.id}`, body)
      ElMessage.success('Обновлено')
      formVisible.value = false
      loadList()
    } else {
      const created: any = await api.post('/catalog/counterparties', { ...body, organizationId: own ? org.currentId : undefined })
      ElMessage.success('Создано — добавьте адрес и договор')
      formVisible.value = false
      router.push(`/catalog/counterparties/${created.id}`)
    }
  } catch (e) { showError(e) }
  saving.value = false
}

onMounted(loadList)
</script>

<style scoped>
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin-left: 130px; }
</style>
