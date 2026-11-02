<template>
  <!-- FP-041: амортизация за месяц — ведомость начисленного, что начислится, начислить / отменить. -->
  <div>
    <div class="page-header">
      <h1>Амортизация</h1>
      <div class="actions">
        <el-date-picker v-model="period" type="month" value-format="YYYY-MM" :clearable="false" style="width: 150px;" @change="load" />
        <el-button v-if="org.can('acc.doc.post')" type="primary" :loading="busy" :disabled="!!r?.previewError" @click="run">{{ r?.posted?.length ? 'Пересчитать' : 'Начислить' }}</el-button>
        <el-button v-if="r?.posted?.length && org.can('acc.doc.cancel')" @click="cancel">Отменить</el-button>
      </div>
    </div>
    <template v-if="r">
      <el-alert v-if="r.previewError" type="error" :closable="false" show-icon class="block" :title="r.previewError" />
      <el-alert v-else-if="r.posted.length && !r.upToDate" type="warning" :closable="false" show-icon class="block" title="Начисленное отличается от расчёта (объекты изменились) — пересчитайте месяц" />
      <el-alert v-else-if="r.posted.length" type="success" :closable="false" show-icon class="block" :title="`Начислено за ${r.period}: ${fmtMoney(r.total)} по ${r.posted.length} объектам`" />
      <el-alert v-else-if="r.preview.length" type="info" :closable="false" show-icon class="block" :title="`За ${r.period} не начислено. Начислится ${fmtMoney(sum(r.preview))} по ${r.preview.length} объектам`" />
      <el-table :data="r.posted.length ? r.posted : r.preview" size="small" empty-text="Объектов к амортизации в этом месяце нет">
        <el-table-column label="Инв. №" width="120" prop="inventoryNumber" />
        <el-table-column label="Объект" min-width="240" prop="name" />
        <el-table-column label="За месяц" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
        <el-table-column label="Накоплено" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.accumulated) }}</template></el-table-column>
        <el-table-column label="Остаточная" width="140" align="right"><template #default="{ row }">{{ fmtMoney(row.bookValue) }}</template></el-table-column>
      </el-table>
      <p class="muted">Прямолинейный способ: (стоимость − ликвидационная) / срок; с месяца, следующего за принятием, по месяц выбытия; последний месяц — остаток. Проводка: Дт счёт затрат / Кт 2420 (2740).</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { fmtMoney, showError } from '../accounting/acc'

const org = useOrgStore()
const d = new Date()
const period = ref(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
const r = ref<any>(null)
const busy = ref(false)
const sum = (rows: any[]) => rows.reduce((s, x) => s + Number(x.amount), 0).toFixed(2)

async function load() { try { r.value = await api.get(`/accounting/assets/depreciation/${period.value}`) } catch (e) { showError(e) } }
async function run() {
  busy.value = true
  try { const x = (await api.post(`/accounting/assets/depreciation/${period.value}`, {})) as any; ElMessage.success(x.changed ? `Начислено ${fmtMoney(x.total)}` : 'Без изменений'); await load() } catch (e) { showError(e) }
  busy.value = false
}
async function cancel() {
  try {
    const { value } = await ElMessageBox.prompt('Причина отмены начисления', `Отменить амортизацию за ${period.value}`, { inputPattern: /.{5,}/, inputErrorMessage: 'Не короче 5 символов' })
    await api.post(`/accounting/assets/depreciation/${period.value}/cancel`, { reason: value }); await load()
  } catch (e: any) { if (e !== 'cancel' && e !== 'close') showError(e) }
}
onMounted(load)
</script>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; }
.block { margin-bottom: 12px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 8px; }
</style>
