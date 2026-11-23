<template>
  <div class="gs" ref="root">
    <el-input
      ref="inputRef" v-model="q" :prefix-icon="Search" placeholder="Поиск: товар, клиент, номер документа" clearable class="gs-input"
      @input="onInput" @focus="open = !!q" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="go(flat[active])" @keydown.esc="close"
    >
      <template #suffix><span v-if="!q" class="gs-kbd">Ctrl K</span></template>
    </el-input>
    <div v-if="open" class="gs-panel">
      <div v-if="loading && !flat.length" class="gs-empty">Ищу…</div>
      <div v-else-if="!flat.length" class="gs-empty">{{ q.trim().length < 2 ? 'Введите хотя бы 2 символа' : 'Ничего не найдено' }}</div>
      <template v-for="g in groups" :key="g.title">
        <div v-if="g.items.length" class="gs-group">{{ g.title }}</div>
        <div
          v-for="it in g.items" :key="it.key" class="gs-item" :class="{ on: flat[active]?.key === it.key }"
          @mousedown.prevent="go(it)" @mouseenter="active = flat.findIndex((x) => x.key === it.key)"
        >
          <el-icon class="gs-ico"><component :is="it.icon" /></el-icon>
          <div class="gs-txt"><div class="gs-title">{{ it.title }}</div><div class="gs-sub">{{ it.sub }}</div></div>
          <span v-if="it.right" class="gs-right">{{ it.right }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/** Поиск по всей системе в шапке: товары, контрагенты, документы. Ctrl+K — фокус, стрелки и Enter — выбор. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Document, Goods, Search, User } from '@element-plus/icons-vue'
import api from '@/api/client'
import { fmtDate, fmtMoney } from '@/utils/format'
import { TRADE_TYPES } from '@/views/accounting/acc'

interface Item { key: string; title: string; sub: string; right?: string; icon: any; to: string }

const router = useRouter()
const root = ref<HTMLElement>()
const inputRef = ref<any>()
const q = ref('')
const open = ref(false)
const loading = ref(false)
const res = ref<any>({ products: [], counterparties: [], documents: [] })
const active = ref(0)

const groups = computed<{ title: string; items: Item[] }[]>(() => [
  { title: 'Товары', items: res.value.products.map((p: any) => ({ key: `p${p.id}`, title: p.name, sub: [p.code && `код ${p.code}`, p.article && `арт. ${p.article}`, p.kind === 'SERVICE' && 'услуга'].filter(Boolean).join(' · '), icon: Goods, to: `/catalog/items/${p.id}` })) },
  { title: 'Контрагенты', items: res.value.counterparties.map((c: any) => ({ key: `c${c.id}`, title: c.name, sub: [c.inn && `БИН/ИИН ${c.inn}`, c.type === 'SUPPLIER' ? 'поставщик' : c.type === 'CUSTOMER' ? 'покупатель' : ''].filter(Boolean).join(' · '), icon: User, to: `/catalog/counterparties/${c.id}` })) },
  { title: 'Документы', items: res.value.documents.map((d: any) => ({ key: `d${d.id}`, title: `${TRADE_TYPES[d.docType]?.ru ?? d.docType} № ${d.number}`, sub: [fmtDate(d.date), d.counterparty?.name].filter(Boolean).join(' · '), right: d.total !== null ? `${fmtMoney(d.total)} ₸` : undefined, icon: Document, to: `/accounting/trade/${d.id}` })) },
])
const flat = computed(() => groups.value.flatMap((g) => g.items))

let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0
function onInput() {
  open.value = !!q.value
  clearTimeout(timer)
  if (q.value.trim().length < 2) { res.value = { products: [], counterparties: [], documents: [] }; return }
  timer = setTimeout(async () => {
    const my = ++seq
    loading.value = true
    try {
      const r = await api.get('/search', { params: { q: q.value.trim() } })
      if (my === seq) { res.value = r; active.value = 0 }
    } catch { if (my === seq) res.value = { products: [], counterparties: [], documents: [] } } finally { if (my === seq) loading.value = false }
  }, 250)
}
function move(d: number) { if (flat.value.length) active.value = (active.value + d + flat.value.length) % flat.value.length }
function go(it?: Item) {
  if (!it) return
  router.push(it.to)
  close()
  q.value = ''
}
function close() { open.value = false; inputRef.value?.blur() }

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inputRef.value?.focus() }
}
function onDoc(e: MouseEvent) { if (root.value && !root.value.contains(e.target as Node)) open.value = false }
onMounted(() => { window.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDoc) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc) })
</script>

<style scoped>
.gs { position: relative; width: 340px; max-width: 100%; }
.gs-kbd { font-size: 11px; color: var(--el-text-color-placeholder); border: 1px solid var(--el-border-color); border-radius: 4px; padding: 0 5px; line-height: 18px; }
.gs-panel { position: absolute; top: calc(100% + 6px); left: 0; width: max(100%, 420px); max-height: 70vh; overflow-y: auto; z-index: 3000; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color-light); border-radius: 10px; box-shadow: var(--el-box-shadow-light); padding: 6px; }
.gs-empty { padding: 14px; color: var(--el-text-color-secondary); font-size: 13px; text-align: center; }
.gs-group { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--el-text-color-secondary); padding: 8px 10px 4px; }
.gs-item { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; cursor: pointer; }
.gs-item.on { background: var(--el-color-primary-light-9); }
.gs-ico { color: var(--el-text-color-secondary); font-size: 16px; }
.gs-txt { flex: 1; min-width: 0; }
.gs-title { font-size: 13px; color: var(--el-text-color-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gs-sub { font-size: 12px; color: var(--el-text-color-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gs-right { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--el-text-color-regular); }
@media (max-width: 900px) { .gs { width: 100%; } .gs-panel { width: 100%; } .gs-kbd { display: none; } }
</style>
