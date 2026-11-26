<template>
  <!-- Файлы документа или контрагента: прикрепить (кнопкой или перетаскиванием), скачать, удалить. -->
  <div class="fl">
    <el-upload v-if="canAdd" drag :show-file-list="false" :http-request="upload" :before-upload="check" class="drop">
      <el-icon class="drop-ic"><UploadFilled /></el-icon>
      <div>Перетащите файл сюда или <em>выберите</em></div>
      <div class="muted small">PDF, Word, Excel, картинки, архивы — до 15 МБ</div>
    </el-upload>
    <div v-loading="loading">
      <div v-if="!items.length && !loading" class="muted small empty">Файлов нет</div>
      <div v-for="f in items" :key="f.id" class="file">
        <el-icon class="ic"><Document /></el-icon>
        <div class="body">
          <el-link type="primary" @click="download(f)">{{ f.fileName }}</el-link>
          <div class="muted small">{{ size(f.size) }} · {{ f.author }} · {{ fmtDateTime(f.createdAt) }}</div>
        </div>
        <el-popconfirm v-if="canAdd" title="Удалить файл?" @confirm="remove(f)"><template #reference><el-button link type="danger" :icon="Delete" /></template></el-popconfirm>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Document, UploadFilled } from '@element-plus/icons-vue'
import api from '@/api/client'
import { fmtDateTime } from '@/utils/format'
import { showError } from '@/views/accounting/acc'

const props = withDefaults(defineProps<{ entityType: 'TRADE' | 'ACC' | 'COUNTERPARTY'; entityId: string; canAdd?: boolean }>(), { canAdd: true })
const items = ref<any[]>([])
const loading = ref(false)
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`)

async function load() {
  if (!props.entityId) return
  loading.value = true
  try { items.value = (await api.get(`/accounting/files/${props.entityType}/${props.entityId}`)) as any } catch (e) { showError(e) } finally { loading.value = false }
}
function check(file: File) {
  if (file.size > 15 * 1024 * 1024) { ElMessage.error('Файл больше 15 МБ'); return false }
  return true
}
async function upload(opt: any) {
  const fd = new FormData()
  fd.append('file', opt.file)
  loading.value = true
  try { items.value = (await api.post(`/accounting/files/${props.entityType}/${props.entityId}`, fd)) as any; ElMessage.success('Файл прикреплён') } catch (e) { showError(e) } finally { loading.value = false }
}
async function download(f: any) {
  try {
    const blob = (await api.get(`/accounting/attachments/${f.id}/download`, { responseType: 'blob' })) as any as Blob
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = f.fileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  } catch (e) { showError(e) }
}
async function remove(f: any) {
  try { await api.delete(`/accounting/attachments/${f.id}`); load() } catch (e) { showError(e) }
}
watch(() => props.entityId, load)
onMounted(load)
</script>

<style scoped>
.drop :deep(.el-upload-dragger) { padding: 14px; border-radius: var(--fp-radius); }
.drop-ic { font-size: 28px; color: var(--el-color-primary); }
.file { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--fp-border-soft); }
.file .body { flex: 1; min-width: 0; }
.ic { font-size: 20px; color: var(--fp-text-3); }
.muted { color: var(--fp-text-3); }
.small { font-size: 12px; }
.empty { padding: 10px 2px; }
</style>
