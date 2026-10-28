<template>
  <div v-loading="loading">
    <div class="page-header">
      <div style="display: flex; align-items: center; gap: 12px;">
        <el-button :icon="ArrowLeft" @click="$router.back()" circle />
        <h1>{{ item?.name }}</h1>
        <el-tag>{{ item?.code }}</el-tag>
      </div>
    </div>

    <el-row :gutter="16" v-if="item">
      <el-col :span="16">
        <el-card>
          <template #header><b>Информация</b></template>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="Код">{{ item.code }}</el-descriptions-item>
            <el-descriptions-item label="Единица">{{ item.unit?.name }}</el-descriptions-item>
            <el-descriptions-item label="Тип">{{ typeLabels[item.itemType] }}</el-descriptions-item>
            <el-descriptions-item label="Группа">{{ item.group?.name || '—' }}</el-descriptions-item>
            <el-descriptions-item label="НДС %">{{ item.vatRate ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="1С GUID">{{ item.onecGuid || '—' }}</el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header><b>Цены</b></template>
          <el-table :data="item.prices" size="small">
            <el-table-column prop="priceType.name" label="Тип цены" />
            <el-table-column label="Цена" align="right">
              <template #default="{ row }">
                {{ formatMoney(row.price, row.currency) }}
              </template>
            </el-table-column>
            <el-table-column prop="currency" label="Валюта" width="80" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="8">
        <el-card>
          <template #header><b>Остатки</b></template>
          <el-table :data="stocks" size="small" :show-header="false">
            <el-table-column prop="warehouse.name" />
            <el-table-column align="right">
              <template #default="{ row }">
                <b>{{ row.quantity }}</b> {{ item.unit?.shortName }}
                <el-text v-if="row.reserved > 0" type="warning" size="small"> (рез: {{ row.reserved }})</el-text>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card style="margin-top: 16px;">
          <template #header><b>Штрихкоды</b></template>
          <div v-for="b in item.barcodes" :key="b.id" style="margin-bottom: 8px;">
            <el-tag>{{ b.barcode }}</el-tag>
            <el-text size="small" type="info"> {{ b.barcodeType }}</el-text>
          </div>
          <el-empty v-if="!item.barcodes?.length" description="Нет штрихкодов" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import api from '@/api/client'

const route = useRoute()
const loading = ref(true)
const item = ref<any>(null)
const stocks = ref<any[]>([])

const typeLabels: Record<string, string> = {
  PRODUCT: 'Товар', SERVICE: 'Услуга', KIT: 'Комплект',
}

function formatMoney(v: number, currency = 'KZT') {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency, minimumFractionDigits: 0 }).format(v)
}

onMounted(async () => {
  const id = route.params.id as string
  const [itemRes, stockRes] = await Promise.all([
    api.get(`/catalog/items/${id}`),
    api.get(`/catalog/items/${id}/stock`),
  ]) as any[]
  item.value = itemRes
  stocks.value = stockRes
  loading.value = false
})
</script>
