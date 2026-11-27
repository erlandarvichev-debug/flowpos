import { registerTheme } from 'echarts/core'

/** Тёмная тема графиков FlowPOS: прозрачный фон (как у карточки), светлые подписи, приглушённая сетка. */
const axis = { axisLine: { lineStyle: { color: '#364152' } }, axisTick: { lineStyle: { color: '#364152' } }, axisLabel: { color: '#a3acb9' }, splitLine: { lineStyle: { color: '#232c39' } } }
registerTheme('fp-dark', {
  backgroundColor: 'transparent',
  textStyle: { color: '#c9d0da' },
  legend: { textStyle: { color: '#c9d0da' } },
  tooltip: { backgroundColor: '#1b2230', borderColor: '#2a3442', textStyle: { color: '#e6e9ee' } },
  categoryAxis: axis,
  valueAxis: axis,
})
