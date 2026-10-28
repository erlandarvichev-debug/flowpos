<template>
  <div>
    <div class="page-header"><h1>{{ t('journal') }}</h1></div>
    <el-card>
      <div class="filters">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" format="DD.MM.YYYY" :clearable="false" style="width: 260px;" />
        <el-radio-group v-model="ledger">
          <el-radio-button value="BU">БУ</el-radio-button>
          <el-radio-button value="NU">НУ</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="reload" :loading="loading">{{ t('build') }}</el-button>
      </div>
      <div v-loading="loading">
        <div v-for="e in entries" :key="e.entryId" class="entry">
          <div class="entry-head" @click="sourceLink(e.source) && router.push(sourceLink(e.source)!)">
            <b>{{ fmtDate(e.date) }}</b>
            <span>{{ DOC_TYPE_LABELS[e.source.docType] || e.source.docType || e.source.type }} {{ e.source.number }}</span>
            <span class="meta">{{ e.rule }} · версия {{ e.sourceVersion }}</span>
          </div>
          <el-table :data="e.postings" size="small" :show-header="false">
            <el-table-column width="60"><template #default="{ row }">{{ row.side === 'D' ? 'Дт' : 'Кт' }}</template></el-table-column>
            <el-table-column min-width="300"><template #default="{ row }"><b>{{ row.account }}</b> {{ row.accountName }}</template></el-table-column>
            <el-table-column width="160" align="right"><template #default="{ row }">{{ fmtMoney(row.amount) }}</template></el-table-column>
            <el-table-column min-width="160" prop="memo" show-overflow-tooltip />
          </el-table>
        </div>
        <el-empty v-if="!loading && !entries.length" description="Нет проводок за период" />
        <div style="margin-top: 12px; display: flex; gap: 8px;" v-if="entries.length || page > 1">
          <el-button :disabled="page === 1" @click="page--; load()">Назад</el-button>
          <el-button :disabled="entries.length < limit" @click="page++; load()">Далее</el-button>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import api from '@/api/client'
import { useI18n } from '@/composables/useI18n'
import { DOC_TYPE_LABELS, fmtDate, fmtMoney, showError, sourceLink } from './acc'

const router = useRouter()
const { t } = useI18n()
const loading = ref(false)
const entries = ref<any[]>([])
const range = ref<[string, string]>([dayjs().startOf('month').format('YYYY-MM-DD'), dayjs().endOf('month').format('YYYY-MM-DD')])
const ledger = ref<'BU' | 'NU'>('BU')
const page = ref(1)
const limit = 100

async function load() {
  loading.value = true
  try {
    const res = (await api.get('/accounting/reports/journal', { params: { from: range.value[0], to: range.value[1], ledger: ledger.value, page: page.value, limit } })) as any
    entries.value = res.entries
  } catch (e) { showError(e) }
  loading.value = false
}

function reload() { page.value = 1; load() }

onMounted(load)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 14px; }
.entry { border: 1px solid #ebeef5; border-radius: 4px; margin-bottom: 10px; }
.entry-head { display: flex; gap: 12px; flex-wrap: wrap; padding: 6px 10px; background: #f5f7fa; cursor: pointer; }
.meta { color: #909399; font-size: 12px; margin-left: auto; }
</style>
