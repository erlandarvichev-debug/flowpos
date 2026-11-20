<template>
  <!-- Рекламная страница flowpos.kz для гостей (не вошедших). Только то, что система умеет на самом деле:
       без выдуманных цифр, отзывов и цен. Контакты показываются, только когда заполнены в CONTACTS. -->
  <div class="landing">
    <header class="nav" :class="{ solid: scrolled }">
      <div class="wrap nav-inner">
        <a href="#top" class="brand" @click.prevent="scrollTo('top')"><img src="/brand/flowpos-wordmark.png" alt="FlowPOS" /></a>
        <nav class="links">
          <a href="#solutions" @click.prevent="scrollTo('solutions')">Решения</a>
          <a href="#supervisor" @click.prevent="scrollTo('supervisor')">Супервайзер</a>
          <a href="#ecosystem" @click.prevent="scrollTo('ecosystem')">Касса и агент</a>
          <a href="#security" @click.prevent="scrollTo('security')">Надёжность</a>
          <a href="#faq" @click.prevent="scrollTo('faq')">Вопросы</a>
        </nav>
        <div class="head-cta">
          <router-link to="/signup" class="btn btn-ghost-light">Регистрация</router-link>
          <router-link to="/login" class="btn btn-light">Войти</router-link>
        </div>
      </div>
    </header>

    <!-- Первый экран -->
    <section id="top" class="hero">
      <div class="blob b1" /><div class="blob b2" /><div class="blob b3" />
      <div class="wrap hero-inner">
        <div class="hero-text">
          <span class="pill reveal">Платформа для торговли в Казахстане</span>
          <h1 class="reveal d1">Учёт, бухгалтерия и торговые представители — <span class="grad">в одном окне</span></h1>
          <p class="lead reveal d2">
            FlowPOS собирает продажи, склад, деньги, зарплату, налоги и работу «в полях» в одну систему.
            Подключайте только нужные направления — и добавляйте новые, когда бизнес растёт.
          </p>
          <div class="cta reveal d3">
            <router-link to="/signup" class="btn btn-primary">Зарегистрировать компанию</router-link>
            <router-link to="/login" class="btn btn-ghost">Войти</router-link>
            <a href="#solutions" class="btn btn-ghost" @click.prevent="scrollTo('solutions')">Что внутри →</a>
          </div>
          <ul class="ticks reveal d4">
            <li>ЭСФ и декларации РК</li>
            <li>Работает с МойСклад</li>
            <li>Данные каждой компании изолированы</li>
          </ul>
        </div>

        <!-- Иллюстрация: условная панель, без настоящих цифр -->
        <div class="hero-visual reveal d2" aria-hidden="true">
          <div class="win">
            <div class="win-bar"><i /><i /><i /><span>flowpos.kz</span></div>
            <div class="win-body">
              <div class="side"><b /><b /><b class="on" /><b /><b /><b /></div>
              <div class="main">
                <div class="row-cards">
                  <div class="mini"><em /><strong /></div>
                  <div class="mini"><em /><strong /></div>
                  <div class="mini"><em /><strong /></div>
                </div>
                <div class="chart">
                  <span v-for="i in 12" :key="i" :style="{ '--h': bars[i - 1] + '%', '--d': i * 0.08 + 's' }" />
                </div>
                <div class="lines"><p /><p /><p /></div>
              </div>
            </div>
          </div>
          <div class="float f1"><span class="dot green" /> Посещение: на точке</div>
          <div class="float f2"><span class="dot blue" /> Заказ отправлен в МойСклад</div>
          <div class="float f3"><span class="dot violet" /> ЭСФ подписан</div>
        </div>
      </div>
      <div class="scroll-hint" @click="scrollTo('solutions')"><span /></div>
    </section>

    <!-- Три направления -->
    <section id="solutions" class="section">
      <div class="wrap">
        <h2 class="reveal">Три направления — подключайте нужные</h2>
        <p class="sub reveal d1">Каждое направление — отдельная подписка. Сотрудник видит только своё: бухгалтер — бухгалтерию, супервайзер — торговых представителей.</p>
        <div class="cards">
          <article v-for="(s, i) in solutions" :key="s.title" class="card reveal" :class="'d' + (i + 1)" @mousemove="tilt" @mouseleave="untilt">
            <div class="card-icon" :style="{ background: s.color }">{{ s.icon }}</div>
            <h3>{{ s.title }}</h3>
            <p class="card-lead">{{ s.lead }}</p>
            <ul>
              <li v-for="f in s.features" :key="f">{{ f }}</li>
            </ul>
            <span class="role">Роли: {{ s.roles }}</span>
          </article>
        </div>
      </div>
    </section>

    <!-- Супервайзер -->
    <section id="supervisor" class="section dark">
      <div class="wrap split">
        <div>
          <span class="pill pill-dark reveal">Новое направление</span>
          <h2 class="reveal d1">Супервайзер: видно, кто где был и что продал</h2>
          <p class="sub reveal d2">Супервайзер ставит маршрут и задания на день. Представитель в приложении «FlowPOS Агент» отмечает посещение, делает фото и оформляет заказ. Система сама определяет, оформлен ли заказ на точке или удалённо.</p>
          <ol class="steps">
            <li class="reveal d2"><b>Маршрут и задания</b> — точки по порядку, задания по точке или общие.</li>
            <li class="reveal d3"><b>Посещение</b> — место телефона, фото выкладки, комментарий, выполненные задания.</li>
            <li class="reveal d4"><b>На точке или удалённо</b> — решает сервер по расстоянию до точки, а не телефон.</li>
            <li class="reveal d5"><b>День на карте и план/факт</b> — сколько точек в плане, сколько пройдено, сколько заказов.</li>
          </ol>
          <p class="note reveal d5">Без постоянной слежки: место берётся только в момент посещения, фото и заказа. Фото хранятся 180 дней.</p>
        </div>

        <div class="map reveal d2" aria-hidden="true">
          <svg viewBox="0 0 400 320">
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="rgba(255,255,255,0.06)" /></pattern>
            </defs>
            <rect width="400" height="320" fill="url(#grid)" />
            <path d="M0 210 C 80 190, 120 240, 200 220 S 330 170, 400 190" stroke="rgba(255,255,255,0.08)" stroke-width="18" fill="none" />
            <path d="M120 0 C 140 90, 90 170, 150 320" stroke="rgba(255,255,255,0.06)" stroke-width="12" fill="none" />
            <path class="route" d="M50 260 L 120 200 L 190 230 L 250 140 L 330 110 L 350 50" fill="none" />
            <g v-for="(p, i) in mapPoints" :key="i" class="pt" :style="{ '--d': 0.6 + i * 0.55 + 's' }">
              <circle :cx="p[0]" :cy="p[1]" r="22" class="halo" :class="p[2]" />
              <circle :cx="p[0]" :cy="p[1]" r="9" class="core" :class="p[2]" />
              <text :x="p[0]" :y="p[1] + 4" text-anchor="middle">{{ i + 1 }}</text>
            </g>
            <circle class="walker" r="6" />
          </svg>
          <div class="legend"><span><i class="dot green" />на точке</span><span><i class="dot orange" />удалённо</span><span><i class="dot blue" />ещё в плане</span></div>
        </div>
      </div>
    </section>

    <!-- Экосистема -->
    <section id="ecosystem" class="section">
      <div class="wrap">
        <h2 class="reveal">Касса, агент и платформа</h2>
        <p class="sub reveal d1">Программы FlowPOS для магазина и для торговых представителей.</p>
        <div class="eco">
          <div v-for="(e, i) in ecosystem" :key="e.title" class="eco-item reveal" :class="'d' + (i + 1)">
            <div class="eco-icon">{{ e.icon }}</div>
            <h3>{{ e.title }}</h3>
            <p>{{ e.text }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Как начать -->
    <section class="section soft">
      <div class="wrap">
        <h2 class="reveal">Как начать</h2>
        <div class="how">
          <div v-for="(h, i) in how" :key="h.title" class="how-item reveal" :class="'d' + (i + 1)">
            <div class="num">{{ i + 1 }}</div>
            <h3>{{ h.title }}</h3>
            <p>{{ h.text }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Надёжность -->
    <section id="security" class="section">
      <div class="wrap">
        <h2 class="reveal">Надёжность и безопасность</h2>
        <div class="sec">
          <div v-for="(s, i) in security" :key="s.title" class="sec-item reveal" :class="'d' + ((i % 3) + 1)">
            <div class="sec-icon">{{ s.icon }}</div>
            <div><h3>{{ s.title }}</h3><p>{{ s.text }}</p></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Вопросы -->
    <section id="faq" class="section soft">
      <div class="wrap narrow">
        <h2 class="reveal">Частые вопросы</h2>
        <div class="faq">
          <details v-for="q in faq" :key="q.q" class="reveal">
            <summary>{{ q.q }}</summary>
            <p>{{ q.a }}</p>
          </details>
        </div>
      </div>
    </section>

    <!-- Призыв -->
    <section class="final">
      <div class="wrap final-inner reveal">
        <h2>Готовы навести порядок в торговле?</h2>
        <p>Зарегистрируйте компанию за минуту — учёт и бухгалтерия включатся сразу. «Супервайзер» подключим по заявке.</p>
        <div class="cta center">
          <router-link to="/signup" class="btn btn-light">Зарегистрировать компанию</router-link>
          <router-link to="/login" class="btn btn-outline">Войти</router-link>
          <a v-if="CONTACTS.whatsapp" :href="`https://wa.me/${CONTACTS.whatsapp}`" target="_blank" rel="noopener" class="btn btn-outline">Написать в WhatsApp</a>
          <a v-if="CONTACTS.phone" :href="`tel:${CONTACTS.phone}`" class="btn btn-outline">{{ CONTACTS.phone }}</a>
          <a v-if="CONTACTS.email" :href="`mailto:${CONTACTS.email}`" class="btn btn-outline">{{ CONTACTS.email }}</a>
        </div>
      </div>
    </section>

    <footer class="foot">
      <div class="wrap foot-inner">
        <img src="/brand/flowpos-wordmark.png" alt="FlowPOS" />
        <span>© {{ year }} FlowPOS · Платформа управления торговлей</span>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** Контакты для кнопок внизу. Пустое поле — кнопки нет (выдуманных контактов на странице быть не должно). */
const CONTACTS = { whatsapp: '', phone: '', email: '' }

const year = new Date().getFullYear()
const scrolled = ref(false)
const bars = [35, 52, 44, 63, 58, 72, 49, 80, 67, 88, 74, 92]
const mapPoints: Array<[number, number, string]> = [[50, 260, 'green'], [120, 200, 'green'], [190, 230, 'orange'], [250, 140, 'green'], [330, 110, 'blue'], [350, 50, 'blue']]

const solutions = [
  {
    icon: '📦', color: 'linear-gradient(135deg,#3b82f6,#06b6d4)', title: 'Учётная система',
    lead: 'Продажи, покупки и склад — от заказа до остатка.',
    features: ['Заказы, реализации, возвраты, розница', 'Поступления, доп. расходы, потребность в закупках', 'Остатки, перемещения, инвентаризации, партии', 'Цены и скидки, номенклатура и штрихкоды', 'Кассы FlowPOS: смены и чеки', 'Взаиморасчёты и акт сверки'],
    roles: 'кладовщик, кассир, руководитель',
  },
  {
    icon: '📊', color: 'linear-gradient(135deg,#8b5cf6,#ec4899)', title: 'Бухгалтерия',
    lead: 'Проводки, деньги, зарплата и налоги по правилам РК.',
    features: ['Банк и касса: выписки, разнесение оплат', 'ЭСФ и зачёт НДС', 'Декларации 300.00, 910.00, налоги с зарплаты', 'Зарплата и кадры, отпуска и больничные', 'Основные средства и амортизация', 'ОСВ, журнал проводок, закрытие месяца'],
    roles: 'главный бухгалтер, бухгалтер, кадровик',
  },
  {
    icon: '🧭', color: 'linear-gradient(135deg,#10b981,#84cc16)', title: 'Супервайзер',
    lead: 'Торговые представители под контролем — без лишних звонков.',
    features: ['Маршруты и задания на день', 'Посещения с фото и комментарием', '«На точке» или «удалённо» — по месту телефона', 'День представителя на карте', 'План и факт: точки и заказы', 'Привязка телефона кодом из 6 цифр'],
    roles: 'супервайзер; представитель — в приложении',
  },
]

const ecosystem = [
  { icon: '🖥️', title: 'Касса FlowPOS', text: 'Для Windows и Android-планшета, есть режим киоска самообслуживания. Работает с МойСклад, весовыми товарами и банковскими терминалами Kaspi и Halyk.' },
  { icon: '📱', title: 'FlowPOS Агент', text: 'Приложение для торговых представителей: каталог МойСклад работает без интернета, заказы уходят, когда появится связь. Акт сверки с клиентом — в PDF.' },
  { icon: '☁️', title: 'Платформа flowpos.kz', text: 'Учёт, бухгалтерия и супервайзер в браузере. Несколько организаций в одном входе, свои роли и права у каждого сотрудника.' },
]

const how = [
  { title: 'Подключаем направления', text: 'Выбираете, что нужно: учётная система, бухгалтерия, супервайзер — по отдельности или вместе.' },
  { title: 'Заводим сотрудников', text: 'Каждому — своя роль: бухгалтер не видит торговых представителей, супервайзер — бухгалтерию.' },
  { title: 'Работаете', text: 'Представители ставят агент на телефон и привязывают его кодом. Супервайзер видит их день на карте.' },
]

const security = [
  { icon: '🔒', title: 'Данные компаний разделены', text: 'Изоляция на уровне базы данных: даже ошибка в программе не покажет чужие записи.' },
  { icon: '🛡️', title: 'Второй фактор', text: 'Опасные операции — пользователи, права, закрытие периода — требуют подтверждения кодом.' },
  { icon: '💾', title: 'Ежедневные копии', text: 'Резервная копия базы каждую ночь и перед каждым обновлением, с проверкой восстановления.' },
  { icon: '📜', title: 'Журнал действий', text: 'Кто, когда и что изменил — проведённые документы не меняются задним числом.' },
  { icon: '🌐', title: 'Только HTTPS', text: 'Соединение всегда зашифровано; перебор паролей ограничен.' },
  { icon: '📍', title: 'Без слежки', text: 'Место представителя — только в момент посещения, фото и заказа, а не весь день.' },
]

const faq = [
  { q: 'Можно подключить только одно направление?', a: 'Да. Учётная система, бухгалтерия и супервайзер подключаются по отдельности, остальные разделы просто не видны.' },
  { q: 'Нужно ли что-то устанавливать?', a: 'Для платформы — нет, она работает в браузере. Торговым представителям нужно приложение «FlowPOS Агент» на Android, магазину — касса FlowPOS.' },
  { q: 'Работает ли с МойСклад?', a: 'Касса и агент работают с МойСклад: каталог, остатки, клиенты и заказы. Супервайзер получает из агента посещения и заказы.' },
  { q: 'Как определяется «на точке»?', a: 'Сервер сравнивает место телефона с местом точки: в пределах радиуса (по умолчанию 100 м) — на точке, дальше — удалённо. Без места — «не определено».' },
  { q: 'Где хранятся данные?', a: 'На сервере платформы; каждая компания видит только свои данные. Резервные копии делаются ежедневно.' },
]

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function tilt(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width - 0.5
  const y = (e.clientY - r.top) / r.height - 0.5
  el.style.transform = `perspective(900px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg) translateY(-4px)`
}
function untilt(e: MouseEvent) { (e.currentTarget as HTMLElement).style.transform = '' }

let observer: IntersectionObserver | null = null
const onScroll = () => { scrolled.value = window.scrollY > 20 }

onMounted(() => {
  document.title = 'FlowPOS — учёт, бухгалтерия и торговые представители'
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
  const items = document.querySelectorAll('.landing .reveal')
  if (!('IntersectionObserver' in window)) { items.forEach((el) => el.classList.add('in')); return }
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); observer?.unobserve(en.target) }
  }, { threshold: 0.12 })
  items.forEach((el) => observer!.observe(el))
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  observer?.disconnect()
  document.title = 'FlowPOS — Платформа управления'
})
</script>

<style scoped>
.landing { --ink: #0f172a; --muted: #64748b; --blue: #3b82f6; --violet: #8b5cf6; --green: #10b981; --orange: #f59e0b;
  color: var(--ink); background: #fff; overflow-x: hidden; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
.narrow { max-width: 820px; }

/* Навигация */
.nav { position: fixed; inset: 0 0 auto 0; z-index: 50; transition: background .3s, box-shadow .3s; }
.nav.solid { background: rgba(15, 23, 42, .88); backdrop-filter: blur(10px); box-shadow: 0 4px 24px rgba(0,0,0,.15); }
.nav-inner { display: flex; align-items: center; gap: 24px; height: 68px; }
.brand img { height: 30px; display: block; }
.links { display: flex; gap: 22px; margin-left: auto; }
.links a { color: rgba(255,255,255,.85); text-decoration: none; font-size: 15px; transition: color .2s; }
.links a:hover { color: #fff; }

/* Кнопки */
.btn { display: inline-flex; align-items: center; justify-content: center; height: 48px; padding: 0 24px; border-radius: 12px; font-weight: 600; font-size: 15px; text-decoration: none; transition: transform .2s, box-shadow .2s, background .2s; cursor: pointer; border: 0; }
.btn:hover { transform: translateY(-2px); }
.btn-primary { background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; box-shadow: 0 10px 30px rgba(99,102,241,.4); }
.btn-primary:hover { box-shadow: 0 14px 40px rgba(99,102,241,.55); }
.btn-ghost { color: #fff; background: rgba(255,255,255,.1); }
.btn-light { background: #fff; color: var(--ink); height: 42px; }
.btn-outline { color: #fff; border: 1.5px solid rgba(255,255,255,.6); background: transparent; }

/* Первый экран */
.hero { position: relative; min-height: 100vh; background: radial-gradient(1200px 600px at 10% -10%, #1e3a8a 0%, transparent 60%), linear-gradient(160deg, #0b1023 0%, #111a3a 55%, #1b1440 100%); color: #fff; display: flex; align-items: center; overflow: hidden; padding: 110px 0 80px; }
.blob { position: absolute; border-radius: 50%; filter: blur(70px); opacity: .55; animation: drift 18s ease-in-out infinite alternate; }
.b1 { width: 420px; height: 420px; background: #3b82f6; top: -120px; right: 10%; }
.b2 { width: 360px; height: 360px; background: #8b5cf6; bottom: -140px; left: 5%; animation-delay: -6s; }
.b3 { width: 260px; height: 260px; background: #10b981; top: 40%; right: -80px; opacity: .35; animation-delay: -12s; }
@keyframes drift { 0% { transform: translate(0,0) scale(1); } 50% { transform: translate(40px,-30px) scale(1.08); } 100% { transform: translate(-30px,20px) scale(.95); } }
.hero-inner { position: relative; display: grid; grid-template-columns: 1.05fr 1fr; gap: 56px; align-items: center; }
.pill { display: inline-block; padding: 6px 14px; border-radius: 999px; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.18); font-size: 13px; margin-bottom: 18px; }
.pill-dark { background: rgba(16,185,129,.15); border-color: rgba(16,185,129,.35); color: #6ee7b7; }
h1 { font-size: clamp(34px, 4.6vw, 56px); line-height: 1.08; font-weight: 800; letter-spacing: -.02em; }
.grad { background: linear-gradient(90deg, #60a5fa, #a78bfa, #34d399, #60a5fa); background-size: 300% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shine 8s linear infinite; }
@keyframes shine { to { background-position: 300% 0; } }
.lead { margin-top: 20px; font-size: 18px; line-height: 1.6; color: rgba(255,255,255,.78); max-width: 560px; }
.cta { display: flex; gap: 14px; margin-top: 30px; flex-wrap: wrap; }
.cta.center { justify-content: center; }
.ticks { list-style: none; display: flex; gap: 20px; margin-top: 28px; flex-wrap: wrap; font-size: 14px; color: rgba(255,255,255,.75); }
.ticks li::before { content: '✓'; color: #34d399; margin-right: 6px; font-weight: 700; }

/* Иллюстрация панели */
.hero-visual { position: relative; }
.win { background: rgba(255,255,255,.96); border-radius: 16px; box-shadow: 0 40px 80px rgba(0,0,0,.45); overflow: hidden; transform: perspective(1400px) rotateY(-10deg) rotateX(4deg); animation: hover 7s ease-in-out infinite; }
@keyframes hover { 50% { transform: perspective(1400px) rotateY(-6deg) rotateX(2deg) translateY(-10px); } }
.win-bar { height: 34px; background: #f1f5f9; display: flex; align-items: center; gap: 6px; padding: 0 12px; }
.win-bar i { width: 10px; height: 10px; border-radius: 50%; background: #fca5a5; }
.win-bar i:nth-child(2) { background: #fcd34d; } .win-bar i:nth-child(3) { background: #86efac; }
.win-bar span { margin-left: 10px; font-size: 11px; color: #94a3b8; }
.win-body { display: flex; height: 300px; }
.side { width: 64px; background: #0f172a; padding: 14px 12px; display: flex; flex-direction: column; gap: 12px; }
.side b { height: 8px; border-radius: 4px; background: rgba(255,255,255,.18); }
.side b.on { background: #60a5fa; }
.main { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.row-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.mini { border-radius: 10px; background: #f8fafc; padding: 10px; display: flex; flex-direction: column; gap: 8px; border: 1px solid #eef2f7; }
.mini em { height: 6px; width: 50%; background: #cbd5e1; border-radius: 3px; }
.mini strong { height: 12px; width: 70%; border-radius: 4px; background: linear-gradient(90deg, #3b82f6, #8b5cf6); }
.mini:nth-child(2) strong { background: linear-gradient(90deg, #10b981, #84cc16); }
.mini:nth-child(3) strong { background: linear-gradient(90deg, #f59e0b, #ef4444); }
.chart { flex: 1; display: flex; align-items: flex-end; gap: 8px; padding: 8px; border-radius: 10px; background: #f8fafc; border: 1px solid #eef2f7; }
.chart span { flex: 1; height: var(--h); border-radius: 4px 4px 0 0; background: linear-gradient(180deg, #818cf8, #3b82f6); transform-origin: bottom; animation: grow 1.2s cubic-bezier(.2,.8,.2,1) var(--d) both, pulse 4s ease-in-out calc(var(--d) + 1.2s) infinite; }
@keyframes grow { from { transform: scaleY(0); } }
@keyframes pulse { 50% { transform: scaleY(.85); } }
.lines p { height: 8px; border-radius: 4px; background: #e2e8f0; margin-bottom: 8px; }
.lines p:nth-child(2) { width: 80%; } .lines p:nth-child(3) { width: 60%; }
.float { position: absolute; background: #fff; color: var(--ink); border-radius: 12px; padding: 10px 14px; font-size: 13px; font-weight: 600; box-shadow: 0 16px 40px rgba(0,0,0,.3); display: flex; align-items: center; gap: 8px; animation: bob 5s ease-in-out infinite; white-space: nowrap; }
.f1 { top: -18px; left: -30px; }
.f2 { bottom: 40px; right: -26px; animation-delay: -1.7s; }
.f3 { bottom: -22px; left: 18%; animation-delay: -3.3s; }
@keyframes bob { 50% { transform: translateY(-10px); } }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot.green { background: var(--green); box-shadow: 0 0 0 4px rgba(16,185,129,.2); }
.dot.blue { background: var(--blue); box-shadow: 0 0 0 4px rgba(59,130,246,.2); }
.dot.violet { background: var(--violet); box-shadow: 0 0 0 4px rgba(139,92,246,.2); }
.dot.orange { background: var(--orange); }
.scroll-hint { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); width: 26px; height: 42px; border: 2px solid rgba(255,255,255,.4); border-radius: 14px; cursor: pointer; }
.scroll-hint span { position: absolute; left: 50%; top: 8px; width: 4px; height: 8px; margin-left: -2px; border-radius: 2px; background: #fff; animation: wheel 1.8s ease-in-out infinite; }
@keyframes wheel { 0% { opacity: 0; transform: translateY(0); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(14px); } }

/* Разделы */
.section { padding: 110px 0; scroll-margin-top: 60px; }
.section.soft { background: #f8fafc; }
.section.dark { background: linear-gradient(160deg, #0b1023, #13203f); color: #fff; }
h2 { font-size: clamp(28px, 3.4vw, 42px); font-weight: 800; letter-spacing: -.02em; line-height: 1.15; text-align: center; }
.sub { text-align: center; color: var(--muted); font-size: 18px; max-width: 720px; margin: 16px auto 0; line-height: 1.6; }
.dark .sub { color: rgba(255,255,255,.75); text-align: left; margin-left: 0; }
.dark h2 { text-align: left; }

.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 56px; }
.card { position: relative; background: #fff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 30px; transition: transform .25s ease, box-shadow .25s ease; will-change: transform; }
.card:hover { box-shadow: 0 30px 60px rgba(15,23,42,.12); }
.card-icon { width: 56px; height: 56px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 28px; margin-bottom: 18px; box-shadow: 0 10px 24px rgba(0,0,0,.12); }
.card h3 { font-size: 22px; font-weight: 700; }
.card-lead { color: var(--muted); margin: 8px 0 16px; line-height: 1.5; }
.card ul { list-style: none; display: flex; flex-direction: column; gap: 9px; margin-bottom: 18px; }
.card li { padding-left: 24px; position: relative; font-size: 15px; line-height: 1.4; }
.card li::before { content: ''; position: absolute; left: 0; top: 6px; width: 12px; height: 7px; border-left: 2px solid var(--green); border-bottom: 2px solid var(--green); transform: rotate(-45deg); }
.role { font-size: 13px; color: var(--muted); border-top: 1px dashed #e2e8f0; padding-top: 12px; display: block; }

.split { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: center; }
.steps { margin: 28px 0 0; padding-left: 0; list-style: none; counter-reset: s; display: flex; flex-direction: column; gap: 14px; }
.steps li { counter-increment: s; position: relative; padding-left: 46px; line-height: 1.5; color: rgba(255,255,255,.85); }
.steps li::before { content: counter(s); position: absolute; left: 0; top: -2px; width: 32px; height: 32px; border-radius: 10px; background: rgba(16,185,129,.18); color: #6ee7b7; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.steps b { color: #fff; }
.note { margin-top: 22px; font-size: 14px; color: rgba(255,255,255,.6); }
.map { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
.map svg { width: 100%; display: block; }
.route { stroke: #60a5fa; stroke-width: 3; stroke-dasharray: 8 8; stroke-dashoffset: 600; }
/* Маршрут рисуется, когда карта появилась на экране */
.map.in .route { animation: dash 3.5s ease forwards .3s; }
@keyframes dash { from { stroke-dashoffset: 600; } to { stroke-dashoffset: 0; } }
.pt { opacity: 0; transform-box: fill-box; transform-origin: center; }
.map.in .pt { animation: pop .5s cubic-bezier(.2,1.4,.4,1) var(--d) forwards; }
@keyframes pop { from { opacity: 0; transform: scale(.3); } to { opacity: 1; transform: scale(1); } }
.core.green { fill: var(--green); } .core.orange { fill: var(--orange); } .core.blue { fill: var(--blue); }
.halo { opacity: .25; animation: ring 2.4s ease-out infinite; transform-box: fill-box; transform-origin: center; }
.halo.green { fill: var(--green); } .halo.orange { fill: var(--orange); } .halo.blue { fill: var(--blue); }
@keyframes ring { 0% { transform: scale(.5); opacity: .45; } 100% { transform: scale(1.4); opacity: 0; } }
.pt text { font-size: 10px; font-weight: 700; fill: #fff; }
.walker { fill: #fff; offset-path: path('M50 260 L 120 200 L 190 230 L 250 140 L 330 110 L 350 50'); filter: drop-shadow(0 0 6px #fff); opacity: 0; }
.map.in .walker { animation: walk 9s linear infinite 3.8s; }
@keyframes walk { 0% { offset-distance: 0%; opacity: 1; } 90% { offset-distance: 100%; opacity: 1; } 100% { offset-distance: 100%; opacity: 0; } }
.legend { display: flex; gap: 18px; justify-content: center; font-size: 13px; color: rgba(255,255,255,.75); margin-top: 8px; }
.legend span { display: flex; align-items: center; gap: 6px; }

.eco { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 56px; }
.eco-item { text-align: center; padding: 34px 26px; border-radius: 20px; background: linear-gradient(180deg, #f8fafc, #fff); border: 1px solid #e2e8f0; transition: transform .25s, box-shadow .25s; }
.eco-item:hover { transform: translateY(-6px); box-shadow: 0 24px 50px rgba(15,23,42,.1); }
.eco-icon { font-size: 44px; margin-bottom: 14px; display: inline-block; animation: bob 5s ease-in-out infinite; }
.eco-item h3 { font-size: 20px; margin-bottom: 10px; }
.eco-item p { color: var(--muted); line-height: 1.6; }

.how { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; margin-top: 56px; position: relative; }
.how-item { text-align: center; }
.num { width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 18px; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 800; color: #fff; background: linear-gradient(135deg, #3b82f6, #8b5cf6); box-shadow: 0 12px 30px rgba(99,102,241,.35); }
.how-item h3 { font-size: 20px; margin-bottom: 8px; }
.how-item p { color: var(--muted); line-height: 1.6; }

.sec { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 56px; }
.sec-item { display: flex; gap: 16px; padding: 22px; border-radius: 16px; border: 1px solid #e2e8f0; transition: border-color .2s, transform .2s; }
.sec-item:hover { border-color: #93c5fd; transform: translateY(-3px); }
.sec-icon { font-size: 28px; }
.sec-item h3 { font-size: 17px; margin-bottom: 6px; }
.sec-item p { color: var(--muted); font-size: 15px; line-height: 1.5; }

.faq { margin-top: 40px; display: flex; flex-direction: column; gap: 12px; }
.faq details { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px 22px; transition: box-shadow .2s; }
.faq details[open] { box-shadow: 0 12px 30px rgba(15,23,42,.08); }
.faq summary { cursor: pointer; font-weight: 600; font-size: 17px; list-style: none; display: flex; justify-content: space-between; gap: 12px; }
.faq summary::-webkit-details-marker { display: none; }
.faq summary::after { content: '+'; font-size: 22px; color: var(--blue); transition: transform .2s; line-height: 1; }
.faq details[open] summary::after { transform: rotate(45deg); }
.faq p { margin-top: 12px; color: var(--muted); line-height: 1.6; }

.final { padding: 100px 0; background: linear-gradient(135deg, #1d4ed8, #7c3aed); color: #fff; text-align: center; position: relative; overflow: hidden; }
.final::before { content: ''; position: absolute; inset: -50%; background: conic-gradient(from 0deg, transparent, rgba(255,255,255,.12), transparent 30%); animation: spin 14s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.final-inner { position: relative; }
.final h2 { color: #fff; }
.final p { margin: 14px 0 28px; font-size: 18px; color: rgba(255,255,255,.85); }

.foot { background: #0b1023; color: rgba(255,255,255,.6); padding: 28px 0; font-size: 14px; }
.foot-inner { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.foot img { height: 24px; }

/* Появление при прокрутке */
.reveal { opacity: 0; transform: translateY(28px); transition: opacity .8s ease, transform .8s cubic-bezier(.2,.8,.2,1); }
.reveal.in { opacity: 1; transform: none; }
.d1 { transition-delay: .08s; } .d2 { transition-delay: .16s; } .d3 { transition-delay: .24s; } .d4 { transition-delay: .32s; } .d5 { transition-delay: .4s; }
.card.reveal.in { transition: opacity .8s ease, transform .25s ease, box-shadow .25s ease; }

@media (max-width: 960px) {
  .links { display: none; }
  .nav-inner .head-cta { margin-left: auto; }
  .hero-inner, .split { grid-template-columns: 1fr; }
  .hero-visual { margin-top: 20px; }
  .f1 { left: 0; } .f2 { right: 0; }
  .cards, .eco, .how, .sec { grid-template-columns: 1fr; }
  .section { padding: 72px 0; }
}
@media (max-width: 520px) {
  .wrap { padding: 0 16px; }
  .float { font-size: 12px; padding: 8px 10px; }
  .f3 { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .landing *, .landing *::before, .landing *::after { animation: none !important; transition: none !important; }
  .reveal { opacity: 1; transform: none; }
  .pt { opacity: 1; } .route { stroke-dashoffset: 0; }
}
.head-cta { display: flex; gap: 8px; align-items: center; }
.btn-ghost-light { height: 42px; color: #fff; border: 1px solid rgba(255, 255, 255, .35); background: transparent; }
.btn-ghost-light:hover { background: rgba(255, 255, 255, .1); }
@media (max-width: 520px) { .btn-ghost-light { display: none; } }
</style>
