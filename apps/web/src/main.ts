import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import ru from 'element-plus/es/locale/lang/ru'
import dayjs from 'dayjs'
import 'dayjs/locale/ru'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import PageIcon from './components/ui/PageIcon.vue'
import './assets/main.css'
import './assets/theme.css'
import './utils/chartTheme'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
// Русские подписи в календарях, постраничности, таблицах (раньше были английские).
dayjs.locale('ru')
app.use(ElementPlus, { locale: ru })

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

// Иконка раздела в старых шапках страниц (class="page-header") — без импорта на каждой странице.
app.component('PageIcon', PageIcon)

app.mount('#app')
