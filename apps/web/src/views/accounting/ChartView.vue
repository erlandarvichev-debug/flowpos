<template>
  <div>
    <div class="page-header">
      <h1>{{ t('chart') }}</h1>
      <el-button v-if="org.can('acc.chart.manage')" type="primary" :icon="Plus" @click="openSub()">Субсчёт</el-button>
    </div>

    <el-card>
      <el-input v-model="search" :placeholder="t('search')" clearable style="max-width: 320px; margin-bottom: 12px;" />
      <el-table :data="tree" row-key="id" v-loading="loading" default-expand-all :tree-props="{ children: 'children' }" size="small">
        <el-table-column :label="t('code')" width="140">
          <template #default="{ row }"><b>{{ row.code }}</b></template>
        </el-table-column>
        <el-table-column :label="t('name')" min-width="320">
          <template #default="{ row }">
            <span :style="{ fontWeight: row.isGroup ? 600 : 400 }">{{ nm(row) }}</span>
            <el-tag v-if="row.isOrgSubaccount" size="small" type="warning" style="margin-left: 6px;">субсчёт организации</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Вид" width="70" align="center">
          <template #default="{ row }">{{ row.isGroup ? '' : row.kind }}</template>
        </el-table-column>
        <el-table-column label="Признаки" width="200">
          <template #default="{ row }">
            <el-tag v-if="row.isGroup" size="small" type="info">групповой</el-tag>
            <el-tag v-if="row.isQuantitative" size="small" style="margin-right: 4px;">кол.</el-tag>
            <el-tag v-if="row.isCurrency" size="small" type="success">вал.</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Аналитика" min-width="260">
          <template #default="{ row }">
            <span v-for="d in row.dims" :key="d" class="dim" :class="{ req: row.requiredDims?.includes(d) }">{{ DIM_LABELS[d] || d }}</span>
          </template>
        </el-table-column>
        <el-table-column width="110" align="right">
          <template #default="{ row }">
            <el-button v-if="!row.isGroup || row.isOrgSubaccount" link type="primary" size="small" @click="openCard(row)">Карточка</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">Обязательные аналитики выделены жирным. Типовой план счетов требует проверки бухгалтером — см. реестр нормативных источников.</div>
    </el-card>

    <el-dialog v-model="subVisible" title="Новый субсчёт организации" width="520px">
      <el-form :model="sub" label-width="140px">
        <el-form-item label="Родительский счёт">
          <el-select v-model="sub.parentCode" filterable style="width: 100%;" @change="onParent">
            <el-option v-for="a in accounts.filter((x) => x.code.length >= 4)" :key="a.id" :value="a.code" :label="`${a.code} ${a.name}`" />
          </el-select>
        </el-form-item>
        <el-form-item label="Код"><el-input v-model="sub.code" placeholder="например 1030.01" /></el-form-item>
        <el-form-item label="Наименование"><el-input v-model="sub.name" /></el-form-item>
        <el-form-item label="Атауы (қаз.)"><el-input v-model="sub.nameKk" /></el-form-item>
        <el-form-item label="Аналитика">
          <el-select v-model="sub.dims" multiple style="width: 100%;">
            <el-option v-for="d in dims" :key="d" :value="d" :label="DIM_LABELS[d] || d" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="subVisible = false">{{ t('close') }}</el-button>
        <el-button type="primary" :loading="saving" @click="saveSub">{{ t('create') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { useI18n } from '@/composables/useI18n'
import { DIM_LABELS, idem, showError } from './acc'

const org = useOrgStore()
const router = useRouter()
const { t, nm } = useI18n()
const loading = ref(false)
const saving = ref(false)
const accounts = ref<any[]>([])
const dims = ref<string[]>([])
const search = ref('')
const subVisible = ref(false)
const sub = ref<any>({ parentCode: '', code: '', name: '', nameKk: '', dims: [] })

const tree = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = q
    ? accounts.value.filter((a) => a.code.startsWith(q) || a.name.toLowerCase().includes(q) || (a.nameKk || '').toLowerCase().includes(q))
    : accounts.value
  if (q) return list.map((a) => ({ ...a, children: undefined }))
  const byId = new Map(list.map((a) => [a.id, { ...a, children: [] as any[] }]))
  const roots: any[] = []
  for (const a of byId.values()) {
    const p = a.parentId && byId.get(a.parentId)
    if (p) p.children.push(a)
    else roots.push(a)
  }
  const clean = (n: any) => { if (!n.children.length) delete n.children; else n.children.forEach(clean); return n }
  return roots.map(clean)
})

async function load() {
  loading.value = true
  try {
    accounts.value = (await api.get('/accounting/chart')) as any
    dims.value = (await api.get('/accounting/chart/dims')) as any
  } catch (e) { showError(e) }
  loading.value = false
}

function openSub() {
  sub.value = { parentCode: '', code: '', name: '', nameKk: '', dims: [] }
  subVisible.value = true
}

function onParent(code: string) {
  const p = accounts.value.find((a) => a.code === code)
  sub.value.code = `${code}.01`
  sub.value.dims = p?.dims ? [...p.dims] : []
}

async function saveSub() {
  saving.value = true
  try {
    await api.post('/accounting/chart/subaccounts', sub.value, idem())
    ElMessage.success('Субсчёт создан')
    subVisible.value = false
    await load()
  } catch (e) { showError(e) }
  saving.value = false
}

function openCard(row: any) {
  router.push({ path: '/accounting/reports/account-card', query: { account: row.code, from: dayjs().startOf('month').format('YYYY-MM-DD'), to: dayjs().endOf('month').format('YYYY-MM-DD') } })
}

onMounted(load)
</script>

<style scoped>
.dim { display: inline-block; font-size: 12px; color: #606266; background: #f4f4f5; border-radius: 3px; padding: 0 6px; margin: 1px 4px 1px 0; }
.dim.req { font-weight: 700; color: #303133; }
.hint { margin-top: 10px; color: #909399; font-size: 12px; }
</style>
