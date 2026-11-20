<template>
  <!-- Подключить, продлить или приостановить решение у организации. История — из журнала подписок. -->
  <el-dialog :model-value="modelValue" :title="`${orgName}: ${solutionName}`" width="560px" @update:model-value="emit('update:modelValue', $event)">
    <el-form :model="form" label-width="160px">
      <el-form-item label="Состояние">
        <el-segmented v-model="form.status" :options="[{ label: 'Пробная', value: 'trial' }, { label: 'Действует', value: 'active' }, { label: 'Приостановлена', value: 'suspended' }]" />
      </el-form-item>
      <el-form-item label="Действует до">
        <el-date-picker v-model="form.validUntil" value-format="YYYY-MM-DD" format="DD.MM.YYYY" placeholder="без срока" />
      </el-form-item>
      <el-form-item v-if="solution === 'supervisor'" label="Мест (торговых)">
        <el-input-number v-model="form.seats" :min="0" :max="10000" placeholder="без ограничения" />
      </el-form-item>
      <el-form-item label="Примечание"><el-input v-model="form.note" type="textarea" :rows="2" placeholder="оплата, договор, контакт" /></el-form-item>
      <el-alert v-if="solution !== 'supervisor' && form.status === 'suspended'" type="warning" :closable="false" show-icon
        :title="`«${solutionName}» приостанавливается в меню сайта клиента: разделы скрываются, данные сохраняются.`" />
    </el-form>
    <h4 class="h">История</h4>
    <el-table :data="history" size="small" max-height="220" empty-text="Изменений не было">
      <el-table-column label="Когда" width="140"><template #default="{ row }">{{ fmtDateTime(row.ts) }}</template></el-table-column>
      <el-table-column label="Кто" min-width="150" prop="userEmail" />
      <el-table-column label="Стало" min-width="200"><template #default="{ row }">{{ describeSub(row.after) }}</template></el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">Отмена</el-button>
      <el-button type="primary" :loading="busy" @click="save">Сохранить</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/client'
import { showError } from '../accounting/acc'
import { describeSub, fmtDateTime } from './admin'

const props = defineProps<{
  modelValue: boolean
  orgId: string
  orgName: string
  solution: string
  solutionName: string
  onByDefault: boolean
  state: any
  note?: string | null
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'saved'): void }>()

const form = ref<any>({})
const history = ref<any[]>([])
const busy = ref(false)

watch(() => props.modelValue, async (open) => {
  if (!open) return
  const s = props.state || { status: 'none' }
  // Срок хранится концом дня по Казахстану — показываем ту же дату.
  const until = s.validUntil ? new Date(new Date(s.validUntil).getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10) : null
  form.value = {
    status: s.status === 'none' ? (props.onByDefault ? 'active' : 'trial') : s.status,
    validUntil: until, seats: s.seats ?? undefined, note: props.note ?? '',
  }
  history.value = []
  try { history.value = ((await api.get(`/platform/organizations/${props.orgId}/events`)) as any).filter((e: any) => e.solution === props.solution) } catch { /* история не обязательна */ }
})

async function save() {
  busy.value = true
  try {
    await api.put(`/platform/organizations/${props.orgId}/subscriptions/${props.solution}`, {
      status: form.value.status, validUntil: form.value.validUntil || null, seats: form.value.seats ?? null, note: form.value.note || null,
    })
    ElMessage.success('Подписка сохранена')
    emit('update:modelValue', false)
    emit('saved')
  } catch (e) { showError(e) }
  busy.value = false
}
</script>

<style scoped>
.h { margin: 14px 0 6px; }
</style>
