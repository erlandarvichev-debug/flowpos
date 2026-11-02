<template>
  <!-- Кнопка «Печать»: формы, подходящие к виду документа; предпросмотр и печать (в т. ч. «Сохранить как PDF»). -->
  <el-dropdown v-if="kinds.length" trigger="click" @command="open">
    <el-button :size="size" :icon="Printer">Печать</el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item v-for="k in kinds" :key="k.kind" :command="k.kind">{{ k.title }}</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>

  <el-dialog v-model="show" :title="current?.title" width="900px" top="4vh" append-to-body>
    <div class="bar">
      <el-select v-model="templateId" style="width: 360px;" @change="loadTemplate">
        <el-option v-for="t in templates" :key="t.id" :value="t.id" :label="`${t.name}${t.builtin ? '' : ` (версия ${t.version})`}${t.isDefault ? ' — по умолчанию' : ''}`" />
      </el-select>
      <span class="spacer" />
      <el-button type="primary" :icon="Printer" :disabled="!data" @click="frame?.print()">Печать / PDF</el-button>
    </div>
    <div v-loading="loading" class="preview"><PrintFrame ref="frame" :html="html" :data="data" /></div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { Printer } from '@element-plus/icons-vue'
import api from '@/api/client'
import PrintFrame from './PrintFrame.vue'
import { showError } from '@/views/accounting/acc'

const props = withDefaults(defineProps<{ source: 'TRADE' | 'ACC' | 'RECON' | 'PAYROLL'; docType?: string; id?: string; query?: Record<string, unknown>; size?: 'small' | 'default' }>(), { size: 'default' })
const all = ref<any[]>([])
const kinds = computed(() => all.value.filter((k) => k.source === props.source && (props.source === 'RECON' || props.source === 'PAYROLL' || k.docTypes.includes(props.docType))))
const show = ref(false)
const current = ref<any>(null)
const templates = ref<any[]>([])
const templateId = ref('')
const html = ref('')
const data = ref<Record<string, unknown> | null>(null)
const loading = ref(false)
const frame = ref<InstanceType<typeof PrintFrame> | null>(null)

async function open(kind: string) {
  current.value = all.value.find((k) => k.kind === kind)
  show.value = true
  loading.value = true
  data.value = null
  try {
    templates.value = (await api.get('/accounting/print/templates', { params: { kind } })) as any
    templateId.value = templates.value[0]?.id ?? ''
    await loadTemplate()
    data.value = (await api.get(`/accounting/print/data/${kind}/${props.id ?? '-'}`, { params: props.query })) as any
  } catch (e) { showError(e) }
  loading.value = false
}
async function loadTemplate() {
  try { html.value = ((await api.get(`/accounting/print/templates/${encodeURIComponent(templateId.value)}`)) as any).html } catch (e) { showError(e) }
}
onMounted(async () => { try { all.value = (await api.get('/accounting/print/kinds')) as any } catch { all.value = [] } })
</script>

<style scoped>
.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.spacer { flex: 1; }
.preview { height: 72vh; }
</style>
