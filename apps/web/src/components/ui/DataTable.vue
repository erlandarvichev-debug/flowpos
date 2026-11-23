<template>
  <div class="dt">
    <div class="dt-top">
    <div class="dt-bar">
      <div class="dt-filters"><slot name="filters" /></div>
      <div class="dt-tools">
        <slot name="tools" />
        <el-popover v-if="storageKey" placement="bottom-end" :width="240" trigger="click">
          <template #reference>
            <el-button :icon="Setting" title="Колонки">Колонки</el-button>
          </template>
          <div class="dt-cols">
            <div class="dt-cols-head">Показывать колонки</div>
            <el-checkbox v-for="c in columns" :key="c.key" :model-value="visible(c)" :disabled="c.required" @change="(v: any) => toggle(c, !!v)">{{ c.label }}</el-checkbox>
            <el-button link type="primary" size="small" @click="resetCols">Как было</el-button>
          </div>
        </el-popover>
        <el-button v-if="exportName" :icon="Download" :loading="exporting" @click="doExport">Excel</el-button>
      </div>
    </div>

    <transition name="dt-fade">
      <div v-if="selectable && selection.length" class="dt-bulk">
        <span>Выбрано: <b>{{ selection.length }}</b></span>
        <slot name="bulk" :rows="selection" />
        <el-button link @click="clearSelection">Снять выбор</el-button>
      </div>
    </transition>
    </div>

    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="dt-err">
      <el-button size="small" @click="$emit('retry')">Повторить</el-button>
    </el-alert>

    <el-table
      ref="tableRef" :data="rows" v-loading="loading" :row-key="rowKey" stripe :size="size" empty-text=" "
      :default-sort="defaultSort" :show-summary="!!summary" :summary-method="summaryMethod"
      :row-class-name="rowClass" @sort-change="onSort" @row-click="onRowClick" @selection-change="(s: any[]) => (selection = s)"
    >
      <el-table-column v-if="selectable" type="selection" width="42" fixed="left" :reserve-selection="true" />
      <template v-for="c in shown" :key="c.key">
        <el-table-column
          :prop="c.key" :label="c.label" :width="c.width" :min-width="c.minWidth ?? (c.width ? undefined : 120)" :align="c.align"
          :sortable="c.sortable ? 'custom' : false" :fixed="c.fixed" :show-overflow-tooltip="c.ellipsis"
        >
          <template #default="{ row }">
            <slot :name="`cell-${c.key}`" :row="row">{{ display(c, row) }}</slot>
          </template>
        </el-table-column>
      </template>
      <el-table-column v-if="$slots.actions" width="60" align="right" fixed="right">
        <template #default="{ row }"><div @click.stop><slot name="actions" :row="row" /></div></template>
      </el-table-column>
    </el-table>

    <el-empty v-if="!loading && !error && !rows.length" :description="emptyText" :image-size="72">
      <slot name="empty" />
    </el-empty>

    <div v-if="total !== undefined && total > 0" class="dt-foot">
      <span class="dt-total">{{ totalText }}</span>
      <el-pagination
        :current-page="page" :page-size="limit" :page-sizes="[25, 50, 100, 200]" :total="total"
        layout="sizes, prev, pager, next" background small
        @update:current-page="(p: number) => $emit('update:page', p)" @update:page-size="onSize"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Единая таблица списков: колонки (показ/скрытие с запоминанием), сортировка на сервере, выбор строк с массовыми
 * действиями, итоговая строка, постраничность, выгрузка в Excel (CSV) всех строк выборки, понятные пустое состояние
 * и ошибка. Ячейки настраиваются слотами #cell-<ключ>.
 */
import { computed, ref } from 'vue'
import { Download, Setting } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { downloadCsv, type CsvCell } from '@/utils/csv'
import { plural } from '@/utils/format'

export interface Col {
  key: string
  label: string
  width?: number
  minWidth?: number
  align?: 'left' | 'right' | 'center'
  /** Сортировка на сервере: true — по ключу, строка — по этому полю. */
  sortable?: boolean | string
  /** Скрыта по умолчанию (включается в «Колонки»). */
  hidden?: boolean
  /** Всегда показывать. */
  required?: boolean
  fixed?: 'left' | 'right'
  ellipsis?: boolean
  /** Текст ячейки (если нет слота). */
  value?: (row: any) => unknown
  /** Значение для Excel; false — не выгружать. */
  export?: ((row: any) => CsvCell) | false
}

const props = withDefaults(defineProps<{
  columns: Col[]
  rows: any[]
  loading?: boolean
  error?: string
  total?: number
  page?: number
  limit?: number
  sort?: string
  storageKey?: string
  selectable?: boolean
  rowKey?: string
  emptyText?: string
  exportName?: string
  /** Все строки выборки для выгрузки (по страницам). Без неё выгружается текущая страница. */
  fetchAll?: () => Promise<any[]>
  /** Итоговая строка: ключ колонки → текст. */
  summary?: Record<string, string>
  clickable?: boolean
  size?: 'small' | 'default' | 'large'
  rowClassName?: (row: any) => string
  unit?: [string, string, string]
}>(), { loading: false, page: 1, limit: 50, rowKey: 'id', emptyText: 'Ничего нет', size: 'default', clickable: false, unit: () => ['запись', 'записи', 'записей'] })

const emit = defineEmits<{
  (e: 'update:page', v: number): void
  (e: 'update:limit', v: number): void
  (e: 'update:sort', v: string): void
  (e: 'row-click', row: any): void
  (e: 'retry'): void
}>()

const tableRef = ref<any>()
const selection = ref<any[]>([])
const exporting = ref(false)

// ── колонки ──
const LS = computed(() => (props.storageKey ? `fp.cols.${props.storageKey}` : ''))
function readCols(): Record<string, boolean> {
  if (!LS.value) return {}
  try { return JSON.parse(localStorage.getItem(LS.value) || '{}') } catch { return {} }
}
const prefs = ref<Record<string, boolean>>(readCols())
const visible = (c: Col) => c.required || (prefs.value[c.key] ?? !c.hidden)
const shown = computed(() => props.columns.filter(visible))
function toggle(c: Col, v: boolean) {
  prefs.value = { ...prefs.value, [c.key]: v }
  try { localStorage.setItem(LS.value, JSON.stringify(prefs.value)) } catch { /* без памяти — только на сеанс */ }
}
function resetCols() {
  prefs.value = {}
  try { localStorage.removeItem(LS.value) } catch { /* ignore */ }
}

const display = (c: Col, row: any) => {
  const v = c.value ? c.value(row) : row?.[c.key]
  return v === null || v === undefined || v === '' ? '—' : v
}

// ── сортировка ──
const sortField = (c: Col) => (typeof c.sortable === 'string' ? c.sortable : c.key)
const defaultSort = computed(() => {
  if (!props.sort) return undefined
  const i = props.sort.lastIndexOf('_')
  const field = props.sort.slice(0, i), dir = props.sort.slice(i + 1)
  const col = props.columns.find((c) => c.sortable && sortField(c) === field)
  return col ? { prop: col.key, order: dir === 'asc' ? 'ascending' : 'descending' } : undefined
})
function onSort({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) {
  const col = props.columns.find((c) => c.key === prop)
  emit('update:sort', !order || !col ? '' : `${sortField(col)}_${order === 'ascending' ? 'asc' : 'desc'}`)
  emit('update:page', 1)
}

function onSize(n: number) { emit('update:limit', n); emit('update:page', 1) }
function onRowClick(row: any, column: any) {
  if (!props.clickable || column?.type === 'selection') return
  emit('row-click', row)
}
const rowClass = ({ row }: { row: any }) => [props.clickable ? 'dt-click' : '', props.rowClassName?.(row) ?? ''].join(' ')
function clearSelection() { tableRef.value?.clearSelection(); selection.value = [] }
defineExpose({ clearSelection })

// ── итог ──
const summaryMethod = ({ columns }: { columns: any[] }) =>
  columns.map((col: any, i: number) => (i === 0 && !props.summary?.[col.property] ? 'Итого' : props.summary?.[col.property] ?? ''))

const totalText = computed(() => `${(props.total ?? 0).toLocaleString('ru-RU')} ${plural(props.total ?? 0, ...props.unit)}`)

// ── выгрузка ──
async function doExport() {
  exporting.value = true
  try {
    const all = props.fetchAll ? await props.fetchAll() : props.rows
    const cols = shown.value.filter((c) => c.export !== false)
    downloadCsv(`${props.exportName}-${new Date().toISOString().slice(0, 10)}`, cols.map((c) => c.label),
      all.map((r) => cols.map((c) => {
        if (typeof c.export === 'function') return c.export(r)
        const v = c.value ? c.value(r) : r?.[c.key]
        return v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v))
      })))
  } catch (e: any) {
    ElMessage.error(e?.message || 'Не удалось выгрузить')
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.dt-bar { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.dt-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; flex: 1; min-width: 0; }
.dt-tools { display: flex; gap: 8px; align-items: center; }
.dt-cols { display: flex; flex-direction: column; gap: 2px; }
.dt-cols-head { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 4px; }
.dt-top { position: relative; }
/* панель выбранных строк — поверх строки фильтров, таблица не сдвигается */
.dt-bulk { position: absolute; top: 0; left: 0; right: 0; z-index: 5; min-height: 32px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 4px 12px; border-radius: 8px; background: var(--el-color-primary-light-9); border: 1px solid var(--el-color-primary-light-7); font-size: 13px; }
.dt-err { margin-bottom: 12px; }
.dt-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.dt-total { color: var(--el-text-color-secondary); font-size: 13px; }
:deep(.dt-click) { cursor: pointer; }
:deep(.el-table__footer-wrapper td) { font-weight: 600; }
.dt-fade-enter-active, .dt-fade-leave-active { transition: opacity .15s; }
.dt-fade-enter-from, .dt-fade-leave-to { opacity: 0; }
</style>
