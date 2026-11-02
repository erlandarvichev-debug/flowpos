<template>
  <!-- Конструктор печатных форм: шаблон (HTML с полями), поля документа, живой предпросмотр на реальном документе,
       версии и шаблон по умолчанию; реквизиты для подписей. -->
  <div class="designer">
    <div class="page-header">
      <h1>Печатные формы</h1>
      <el-segmented v-model="tab" :options="[{ label: 'Конструктор', value: 'design' }, { label: 'Реквизиты и подписи', value: 'settings' }]" />
    </div>

    <template v-if="tab === 'design'">
      <div class="toolbar">
        <el-select v-model="kind" style="width: 330px;" @change="onKind"><el-option v-for="k in kinds" :key="k.kind" :value="k.kind" :label="k.title" /></el-select>
        <el-select v-model="templateId" style="width: 330px;" @change="loadTemplate">
          <el-option v-for="t in templates" :key="t.id" :value="t.id" :label="`${t.name}${t.builtin ? ' (встроенный)' : ` · версия ${t.version}`}${t.isDefault ? ' ✓' : ''}`" />
        </el-select>
        <el-button v-if="cur && !cur.isDefault && canManage" @click="makeDefault">Сделать по умолчанию</el-button>
        <el-button v-if="cur && !cur.builtin && canManage" type="danger" plain @click="archive">В архив</el-button>
        <span class="spacer" />
        <el-date-picker v-if="kindDef?.source === 'PAYROLL'" v-model="sampleId" type="month" value-format="YYYY-MM" placeholder="Месяц" style="width: 150px;" @change="loadData" />
        <el-select v-else-if="kindDef?.source !== 'RECON'" v-model="sampleId" filterable placeholder="Документ для предпросмотра" style="width: 280px;" @change="loadData">
          <el-option v-for="d in samples" :key="d.id" :value="d.id" :label="`${d.number ?? '—'} от ${fmtDate(d.date)}`" />
        </el-select>
        <template v-else>
          <el-select v-model="recon.counterpartyId" filterable remote :remote-method="searchCp" placeholder="Контрагент" style="width: 220px;" @change="loadData">
            <el-option v-for="o in cpOptions" :key="o.value" :value="o.value" :label="o.label" />
          </el-select>
          <el-date-picker v-model="recon.range" type="daterange" value-format="YYYY-MM-DD" style="width: 240px;" @change="loadData" />
        </template>
      </div>
      <el-alert v-if="tplSource" type="info" :closable="false" show-icon class="block" :title="`Основа: ${tplSource}`" />

      <div class="workspace">
        <div class="fields">
          <div class="cap">Поля документа — нажмите, чтобы вставить</div>
          <el-input v-model="fieldFilter" size="small" placeholder="Поиск поля" clearable class="ff" />
          <div class="list">
            <div v-for="f in fieldList" :key="f.path" class="field" :title="f.sample" @click="insertField(f)">
              <code>{{ f.label }}</code><span class="sample">{{ f.sample }}</span>
            </div>
          </div>
          <div class="cap help">
            <code v-pre>{{поле|money}}</code> сумма · <code v-pre>|date</code> дата · <code v-pre>|qty</code> количество · <code v-pre>|words</code> прописью ·
            <code v-pre>{{#each lines}}…{{/each}}</code> строки · <code v-pre>{{@n}}</code> № · <code v-pre>{{#if поле}}…{{else}}…{{/if}}</code>
          </div>
        </div>
        <div class="editor">
          <el-input ref="editorRef" v-model="html" type="textarea" :readonly="!canManage" class="code" resize="none" @input="dirty = true" />
          <div class="save">
            <el-input v-model="name" placeholder="Название шаблона" style="flex: 1;" />
            <el-checkbox v-model="makeDefaultOnSave">по умолчанию</el-checkbox>
            <el-button v-if="canManage" type="primary" :disabled="!dirty && !cur?.builtin" @click="save">{{ cur?.builtin ? 'Сохранить как свой' : 'Сохранить версию' }}</el-button>
          </div>
          <div v-if="problems.length" class="problems"><div v-for="p in problems" :key="p">⚠ {{ p }}</div></div>
        </div>
        <div class="preview">
          <div class="cap">Предпросмотр <el-button size="small" :icon="Printer" :disabled="!data" style="margin-left: 8px;" @click="frame?.print()">Печать / PDF</el-button></div>
          <PrintFrame ref="frame" :html="html" :data="data" />
        </div>
      </div>
      <div v-if="cur?.versions?.length > 1" class="versions muted">Версии: <span v-for="v in cur.versions" :key="v.id"><el-link @click="templateId = v.id; loadTemplate()">{{ v.version }}</el-link> · </span></div>
    </template>

    <el-card v-else class="settings" shadow="never">
      <el-form label-width="190px" :disabled="!canManage">
        <el-form-item label="Руководитель (Ф. И. О.)"><el-input v-model="st.director" /></el-form-item>
        <el-form-item label="Главный бухгалтер"><el-input v-model="st.accountant" /></el-form-item>
        <el-form-item label="Кассир"><el-input v-model="st.cashier" /></el-form-item>
        <el-form-item label="Адрес для документов"><el-input v-model="st.address" /></el-form-item>
        <el-form-item label="Телефон"><el-input v-model="st.phone" /></el-form-item>
        <el-form-item label="Кбе"><el-input v-model="st.kbe" maxlength="2" style="width: 80px;" /><span class="muted" style="margin-left: 8px;">17 — юрлицо-резидент, 19 — ИП (по умолчанию)</span></el-form-item>
        <el-form-item><el-button type="primary" @click="saveSettings">Сохранить</el-button></el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Printer } from '@element-plus/icons-vue'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import PrintFrame from '@/components/print/PrintFrame.vue'
import { fieldPaths, validate } from '@print-engine'
import { fmtDate, showError, loadDimOptions } from '../accounting/acc'

const org = useOrgStore()
const canManage = computed(() => org.can('acc.refs.manage'))
const tab = ref<'design' | 'settings'>('design')
const kinds = ref<any[]>([])
const kind = ref('')
const kindDef = computed(() => kinds.value.find((k) => k.kind === kind.value))
const templates = ref<any[]>([])
const templateId = ref('')
const cur = ref<any>(null)
const tplSource = ref('')
const html = ref('')
const name = ref('')
const dirty = ref(false)
const makeDefaultOnSave = ref(false)
const samples = ref<any[]>([])
const sampleId = ref('')
const data = ref<Record<string, unknown> | null>(null)
const recon = ref<{ counterpartyId: string; range: [string, string] | null }>({ counterpartyId: '', range: null })
const cpOptions = ref<{ value: string; label: string }[]>([])
const fieldFilter = ref('')
const frame = ref<InstanceType<typeof PrintFrame> | null>(null)
const editorRef = ref<any>(null)
const st = ref<any>({})

const problems = computed(() => validate(html.value))
const fieldList = computed(() => {
  if (!data.value) return []
  const q = fieldFilter.value.toLowerCase()
  return fieldPaths(data.value).map((f) => ({ ...f, label: f.list ? `#each ${f.path}` : f.path.replace(/^.*\[\]\./, '') + (f.path.includes('[]') ? ' (в строке)' : '') }))
    .filter((f) => !q || f.path.toLowerCase().includes(q) || f.sample.toLowerCase().includes(q))
})

function insertField(f: { path: string; list?: boolean }) {
  const ta: HTMLTextAreaElement | undefined = editorRef.value?.textarea
  const text = f.list ? `{{#each ${f.path}}}\n{{/each}}` : `{{${f.path.replace(/^.*\[\]\./, '')}}}`
  if (!ta) { html.value += text; return }
  const s = ta.selectionStart, e = ta.selectionEnd
  html.value = html.value.slice(0, s) + text + html.value.slice(e)
  dirty.value = true
  nextTick(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length })
}

async function onKind() {
  data.value = null; sampleId.value = ''; samples.value = []
  try {
    templates.value = (await api.get('/accounting/print/templates', { params: { kind: kind.value } })) as any
    templateId.value = templates.value[0]?.id ?? ''
    await loadTemplate()
    const k = kindDef.value
    if (k?.source === 'TRADE') samples.value = ((await api.get('/accounting/trade-documents', { params: { docType: k.docTypes.join(','), limit: 30 } })) as any).items
    if (k?.source === 'ACC') samples.value = ((await api.get('/accounting/documents', { params: { docType: k.docTypes.join(','), limit: 30 } })) as any).items
    if (k?.source === 'PAYROLL') { const d = new Date(); sampleId.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; await loadData().catch(() => null) }
    if (samples.value[0]) { sampleId.value = samples.value[0].id; await loadData() }
  } catch (e) { showError(e) }
}
async function loadTemplate() {
  try {
    cur.value = { ...(templates.value.find((t) => t.id === templateId.value) ?? {}), ...((await api.get(`/accounting/print/templates/${encodeURIComponent(templateId.value)}`)) as any) }
    html.value = cur.value.html
    name.value = cur.value.builtin ? `${cur.value.name.replace(/ \(стандартный\)$/, '')} — наш` : cur.value.name
    tplSource.value = cur.value.source ?? ''
    dirty.value = false
  } catch (e) { showError(e) }
}
async function loadData() {
  try {
    if (kindDef.value?.source === 'RECON') {
      if (!recon.value.counterpartyId || !recon.value.range) return
      data.value = (await api.get(`/accounting/print/data/${kind.value}/-`, { params: { counterpartyId: recon.value.counterpartyId, from: recon.value.range[0], to: recon.value.range[1] } })) as any
    } else if (sampleId.value) data.value = (await api.get(`/accounting/print/data/${kind.value}/${sampleId.value}`)) as any
  } catch (e) { showError(e) }
}
async function searchCp(q: string) { cpOptions.value = await loadDimOptions('COUNTERPARTY', q) }
async function save() {
  if (problems.value.length) return ElMessage.error('Исправьте шаблон: ' + problems.value[0])
  try {
    const body = cur.value.builtin ? { basedOn: cur.value.id, name: name.value, html: html.value, makeDefault: makeDefaultOnSave.value } : { family: cur.value.family, name: name.value, html: html.value, makeDefault: makeDefaultOnSave.value }
    const row = (await api.post('/accounting/print/templates', body)) as any
    ElMessage.success(`Сохранено: версия ${row.version}`)
    templates.value = (await api.get('/accounting/print/templates', { params: { kind: kind.value } })) as any
    templateId.value = row.id
    await loadTemplate()
  } catch (e) { showError(e) }
}
async function makeDefault() {
  try { templates.value = (await api.post(`/accounting/print/templates/${encodeURIComponent(templateId.value)}/default`, {})) as any; ElMessage.success('Шаблон по умолчанию изменён') } catch (e) { showError(e) }
}
async function archive() {
  try {
    await ElMessageBox.confirm(`Отправить шаблон «${cur.value.name}» в архив? Все его версии перестанут предлагаться при печати.`, 'В архив', { type: 'warning' })
    await api.post(`/accounting/print/families/${cur.value.family}/archive`, {})
    await onKind()
  } catch (e: any) { if (e !== 'cancel' && e !== 'close') showError(e) }
}
async function saveSettings() {
  try { st.value = (await api.put('/accounting/print/settings', st.value)) as any; ElMessage.success('Реквизиты сохранены'); if (kind.value) await loadData() } catch (e) { showError(e) }
}
onMounted(async () => {
  try {
    kinds.value = (await api.get('/accounting/print/kinds')) as any
    st.value = ((await api.get('/accounting/print/settings')) as any) ?? {}
    kind.value = kinds.value[0]?.kind ?? ''
    await onKind()
  } catch (e) { showError(e) }
})
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: center; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.spacer { flex: 1; }
.block { margin-bottom: 10px; }
.workspace { display: grid; grid-template-columns: 240px 1fr 1fr; gap: 12px; height: calc(100vh - 250px); min-height: 520px; }
.fields, .editor, .preview { display: flex; flex-direction: column; min-height: 0; }
.cap { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.help { margin-top: 8px; line-height: 1.7; }
.ff { margin-bottom: 6px; }
.list { flex: 1; overflow: auto; border: 1px solid var(--el-border-color-lighter); border-radius: 4px; }
.field { padding: 4px 8px; cursor: pointer; display: flex; flex-direction: column; border-bottom: 1px solid var(--el-border-color-extra-light); }
.field:hover { background: var(--el-fill-color-light); }
.field code { font-size: 12px; }
.sample { font-size: 11px; color: var(--el-text-color-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.code { flex: 1; }
.code :deep(textarea) { height: 100% !important; font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5; }
.save { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.problems { color: var(--el-color-danger); font-size: 12px; margin-top: 6px; }
.preview :deep(.print-frame) { flex: 1; min-height: 0; }
.versions { margin-top: 8px; font-size: 12px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.settings { max-width: 720px; }
</style>
