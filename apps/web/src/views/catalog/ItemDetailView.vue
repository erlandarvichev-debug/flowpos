<template>
  <div v-loading="loading">
    <div class="page-header">
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <el-button :icon="ArrowLeft" @click="$router.back()" circle aria-label="Назад" />
        <h1>{{ item?.name }}</h1>
        <el-tag v-if="item?.code">{{ item.code }}</el-tag>
        <el-tag v-if="item?.deleted" type="danger">в архиве</el-tag>
      </div>
    </div>

    <el-row :gutter="16" v-if="item">
      <el-col :xs="24" :md="16">
        <el-card>
          <template #header><b>Информация</b></template>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="Код">{{ item.code || '—' }}</el-descriptions-item>
            <el-descriptions-item label="Артикул">{{ item.article || '—' }}</el-descriptions-item>
            <el-descriptions-item label="Единица">{{ item.uom?.name || '—' }}</el-descriptions-item>
            <el-descriptions-item label="Вид">{{ KIND[item.kind] ?? item.kind }}</el-descriptions-item>
            <el-descriptions-item label="Группа">{{ item.group?.name || '—' }}</el-descriptions-item>
            <el-descriptions-item label="НДС %">{{ item.vatRate ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="PLU весового">{{ item.plu || '—' }}</el-descriptions-item>
            <el-descriptions-item label="Справочник">{{ item.organizationId ? 'личный (этой организации)' : 'общий для организаций клиента' }}</el-descriptions-item>
            <el-descriptions-item v-if="item.parent" label="Вариант товара" :span="2">
              <el-link type="primary" @click="go(item.parent.id)">{{ item.parent.name }}</el-link>
              <span class="muted"> · {{ attrs(item.attributes) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="ID в FlowPOS" :span="2"><code>{{ item.id }}</code></el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card v-if="item.variants?.length" style="margin-top: 16px;">
          <template #header><b>Варианты</b></template>
          <el-table :data="item.variants" size="small">
            <el-table-column label="Вариант"><template #default="{ row }"><el-link type="primary" @click="go(row.id)">{{ row.name }}</el-link></template></el-table-column>
            <el-table-column label="Характеристики"><template #default="{ row }">{{ attrs(row.attributes) }}</template></el-table-column>
            <el-table-column prop="code" label="Код" width="120" />
          </el-table>
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header><b>Цены</b></template>
          <el-table :data="item.prices" size="small" empty-text="Цен нет">
            <el-table-column prop="priceType.name" label="Тип цены" />
            <el-table-column label="Цена" align="right">
              <template #default="{ row }">{{ formatMoney(row.price, row.currency) }}</template>
            </el-table-column>
            <el-table-column prop="currency" label="Валюта" width="80" />
          </el-table>
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header><b>История изменений</b></template>
          <el-table :data="versions" size="small" empty-text="Истории нет">
            <el-table-column prop="version" label="Версия" width="80" />
            <el-table-column label="Когда" width="150"><template #default="{ row }">{{ dt(row.createdAt) }}</template></el-table-column>
            <el-table-column label="Что изменилось">
              <template #default="{ row }">
                <span v-if="!row.changed.length">создан</span>
                <span v-else>{{ row.changed.map((c: string) => FIELD[c] ?? c).join(', ') }}</span>
                <div class="muted">{{ row.snapshot.name }}<span v-if="row.snapshot.vatRate != null"> · НДС {{ row.snapshot.vatRate }}%</span></div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="8">
        <el-card>
          <template #header><b>Остатки</b></template>
          <el-table :data="stocks" size="small" :show-header="false" empty-text="Остатков нет">
            <el-table-column prop="store.name" />
            <el-table-column align="right">
              <template #default="{ row }"><b>{{ Number(row.qty) }}</b> {{ item.uom?.shortName }}</template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header><b>Штрихкоды</b></template>
          <div v-for="b in item.barcodes" :key="b.id" class="bc">
            <div>
              <el-tag>{{ b.barcode }}</el-tag>
              <el-text size="small" type="info"> {{ b.kind }}</el-text>
              <div class="muted">
                <span v-if="Number(b.factor) !== 1">упаковка: {{ Number(b.factor) }} {{ item.uom?.shortName }}<span v-if="b.uom"> ({{ b.uom.shortName }})</span> · </span>
                {{ SOURCE[b.source] ?? b.source }}
              </div>
            </div>
            <el-button v-if="canManage && b.source === 'MANUAL'" link type="danger" size="small" @click="removeBarcode(b)">Убрать</el-button>
          </div>
          <el-empty v-if="!item.barcodes?.length" :description="item.variants?.length ? 'Штрихкоды — у вариантов' : 'Нет штрихкодов'" :image-size="60" />
          <el-form v-if="canManage && !item.variants?.length" class="add" @submit.prevent="addBarcode">
            <el-input v-model="bc.barcode" placeholder="Штрихкод" clearable aria-label="Новый штрихкод" />
            <div class="row">
              <el-select v-model="bc.kind" placeholder="Тип: авто" clearable style="width: 130px;">
                <el-option v-for="k in KINDS" :key="k" :label="k" :value="k" />
              </el-select>
              <el-input-number v-model="bc.factor" :min="0.001" :precision="3" :step="1" controls-position="right" style="width: 130px;" aria-label="Количество в упаковке" />
            </div>
            <div class="muted">Количество базовых единиц в одной отсканированной (1 — штучный, 12 — коробка)</div>
            <el-button type="primary" size="small" native-type="submit" :loading="busy">Добавить</el-button>
          </el-form>
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header><b>Связи с учётными системами</b></template>
          <div v-for="m in mappings" :key="m.id" class="map">
            <div>{{ SYSTEM[m.system] ?? m.system }} <el-tag size="small" :type="m.status === 'ACTIVE' ? 'success' : 'info'">{{ m.status === 'ACTIVE' ? 'действует' : 'прежняя' }}</el-tag></div>
            <div class="muted"><code>{{ m.externalId }}</code><span v-if="m.account"> · {{ m.account }}</span></div>
          </div>
          <el-empty v-if="!mappings.length" description="Товар заведён в FlowPOS" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api/client'
import { useOrgStore } from '@/stores/org'
import { showError } from '../accounting/acc'

const route = useRoute()
const router = useRouter()
const org = useOrgStore()
const canManage = computed(() => org.can('catalog.manage'))
const loading = ref(true)
const busy = ref(false)
const item = ref<any>(null)
const stocks = ref<any[]>([])
const versions = ref<any[]>([])
const mappings = ref<any[]>([])
const bc = reactive<{ barcode: string; kind: string; factor: number }>({ barcode: '', kind: '', factor: 1 })

const KIND: Record<string, string> = { PRODUCT: 'Товар', SERVICE: 'Услуга', BUNDLE: 'Комплект', VARIANT: 'Вариант' }
const KINDS = ['EAN13', 'EAN8', 'UPCA', 'GTIN14', 'CODE128']
const SOURCE: Record<string, string> = { MANUAL: 'добавлен вручную', MOYSKLAD: 'из МойСклад', ONEC: 'из 1С', LEGACY: 'из карточки (обмен)' }
const SYSTEM: Record<string, string> = { MOYSKLAD: 'МойСклад', ONEC: '1С' }
const FIELD: Record<string, string> = { name: 'наименование', code: 'код', article: 'артикул', kind: 'вид', groupId: 'группа', uomId: 'единица', vatRate: 'НДС', parentId: 'основной товар', variantKey: 'характеристики', attributes: 'характеристики', plu: 'PLU', deleted: 'архив', organizationId: 'справочник' }

const attrs = (a: any) => (a && typeof a === 'object' ? Object.entries(a).map(([k, v]) => `${k}: ${v}`).join(', ') : '')
const dt = (v: string) => new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
const go = (id: string) => router.push(`/catalog/items/${id}`)

function formatMoney(v: number, currency = 'KZT') {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency, minimumFractionDigits: 0 }).format(Number(v))
}

async function load() {
  loading.value = true
  const id = route.params.id as string
  try {
    const [i, s, v, m] = await Promise.all([
      api.get(`/catalog/items/${id}`),
      api.get(`/catalog/items/${id}/stock`).catch(() => []),
      api.get(`/catalog/items/${id}/versions`),
      api.get(`/catalog/items/${id}/mappings`),
    ]) as any[]
    item.value = i
    stocks.value = s
    versions.value = v
    mappings.value = m
  } catch (e) { showError(e) }
  loading.value = false
}

async function addBarcode() {
  if (!bc.barcode.trim()) return
  busy.value = true
  try {
    await api.post(`/catalog/items/${item.value.id}/barcodes`, { barcode: bc.barcode, kind: bc.kind || undefined, factor: bc.factor })
    Object.assign(bc, { barcode: '', kind: '', factor: 1 })
    ElMessage.success('Штрихкод добавлен')
    await load()
  } catch (e) { showError(e) }
  busy.value = false
}

async function removeBarcode(b: any) {
  try {
    await ElMessageBox.confirm(`Убрать штрихкод ${b.barcode}? На кассе товар по нему больше не найдётся.`, 'Штрихкод', { confirmButtonText: 'Убрать', cancelButtonText: 'Отмена', type: 'warning' })
  } catch { return }
  try {
    await api.delete(`/catalog/items/${item.value.id}/barcodes/${b.id}`)
    await load()
  } catch (e) { showError(e) }
}

watch(() => route.params.id, (id) => { if (id) load() })
onMounted(load)
</script>

<style scoped>
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.bc, .map { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
.map { flex-direction: column; gap: 2px; }
.add { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
