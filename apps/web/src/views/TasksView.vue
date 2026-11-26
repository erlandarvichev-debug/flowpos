<template>
  <div>
    <PageHeader title="Задачи" :subtitle="subtitle" />
    <el-card shadow="never">
      <div class="filters">
        <el-radio-group v-model="scope">
          <el-radio-button value="mine">Мои</el-radio-button>
          <el-radio-button value="created">Поставил я</el-radio-button>
          <el-radio-button value="all">Все</el-radio-button>
        </el-radio-group>
        <el-radio-group v-model="done">
          <el-radio-button value="0">В работе</el-radio-button>
          <el-radio-button value="1">Выполненные</el-radio-button>
        </el-radio-group>
        <el-checkbox v-model="overdue" :disabled="done === '1'">Только просроченные</el-checkbox>
        <el-input v-model="search" placeholder="Поиск" clearable style="width: 220px;" :prefix-icon="Search" />
      </div>
      <TaskList :scope="scope" :done="done" :overdue="overdue && done === '0'" :search="search" :can-add="done === '0'" @changed="loadSummary" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import api from '@/api/client'
import PageHeader from '@/components/ui/PageHeader.vue'
import TaskList from '@/components/tasks/TaskList.vue'

const scope = ref<'mine' | 'created' | 'all'>('mine')
const done = ref<'0' | '1'>('0')
const overdue = ref(false)
const search = ref('')
const sum = ref<{ open: number; overdue: number; today: number } | null>(null)
const subtitle = computed(() => (sum.value ? `У вас в работе ${sum.value.open}, просрочено ${sum.value.overdue}, на ближайшие сутки ${sum.value.today}` : 'Поручения сотрудникам со сроками'))
async function loadSummary() { try { sum.value = (await api.get('/accounting/tasks/summary')) as any } catch { sum.value = null } }
onMounted(loadSummary)
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
</style>
