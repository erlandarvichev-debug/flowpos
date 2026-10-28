import { ref } from 'vue'

export type Lang = 'ru' | 'kk'

function readLang(): Lang {
  try { return (localStorage.getItem('fp_lang') as Lang) === 'kk' ? 'kk' : 'ru' } catch { return 'ru' }
}

const lang = ref<Lang>(readLang())

const dict: Record<string, { ru: string; kk: string }> = {
  accounting: { ru: 'Бухгалтерия', kk: 'Бухгалтерия' },
  chart: { ru: 'План счетов', kk: 'Шоттар жоспары' },
  documents: { ru: 'Документы', kk: 'Құжаттар' },
  trialBalance: { ru: 'Оборотно-сальдовая ведомость', kk: 'Айналым-сальдо ведомосы' },
  accountCard: { ru: 'Карточка счёта', kk: 'Шот карточкасы' },
  journal: { ru: 'Журнал проводок', kk: 'Өткізбелер журналы' },
  refs: { ru: 'Справочники учёта', kk: 'Есеп анықтамалықтары' },
  settings: { ru: 'Настройки учёта', kk: 'Есеп баптаулары' },
  organization: { ru: 'Организация', kk: 'Ұйым' },
  newOrganization: { ru: 'Новая организация', kk: 'Жаңа ұйым' },
  code: { ru: 'Код', kk: 'Код' },
  name: { ru: 'Наименование', kk: 'Атауы' },
  date: { ru: 'Дата', kk: 'Күні' },
  number: { ru: 'Номер', kk: 'Нөмірі' },
  type: { ru: 'Тип', kk: 'Түрі' },
  status: { ru: 'Статус', kk: 'Мәртебесі' },
  amount: { ru: 'Сумма', kk: 'Сомасы' },
  comment: { ru: 'Комментарий', kk: 'Түсініктеме' },
  period: { ru: 'Период', kk: 'Кезең' },
  search: { ru: 'Поиск', kk: 'Іздеу' },
  create: { ru: 'Создать', kk: 'Құру' },
  save: { ru: 'Сохранить', kk: 'Сақтау' },
  post: { ru: 'Провести', kk: 'Өткізу' },
  unpost: { ru: 'Отменить проведение', kk: 'Өткізуден бас тарту' },
  storno: { ru: 'Сторно', kk: 'Сторно' },
  cancel: { ru: 'Пометить на удаление', kk: 'Жоюға белгілеу' },
  restore: { ru: 'Восстановить', kk: 'Қалпына келтіру' },
  copy: { ru: 'Скопировать', kk: 'Көшіру' },
  close: { ru: 'Закрыть', kk: 'Жабу' },
  debit: { ru: 'Дебет', kk: 'Дебет' },
  credit: { ru: 'Кредит', kk: 'Кредит' },
  opening: { ru: 'Сальдо на начало', kk: 'Бастапқы сальдо' },
  turnover: { ru: 'Обороты за период', kk: 'Кезең айналымы' },
  closing: { ru: 'Сальдо на конец', kk: 'Соңғы сальдо' },
  total: { ru: 'Итого', kk: 'Барлығы' },
  postings: { ru: 'Проводки', kk: 'Өткізбелер' },
  related: { ru: 'Связанные документы', kk: 'Байланысты құжаттар' },
  history: { ru: 'История версий', kk: 'Нұсқалар тарихы' },
  lines: { ru: 'Строки', kk: 'Жолдар' },
  addLine: { ru: 'Добавить строку', kk: 'Жол қосу' },
  account: { ru: 'Счёт', kk: 'Шот' },
  corr: { ru: 'Кор. счёт', kk: 'Корр. шот' },
  balance: { ru: 'Сальдо', kk: 'Сальдо' },
  build: { ru: 'Сформировать', kk: 'Қалыптастыру' },
  reason: { ru: 'Причина', kk: 'Себебі' },
  trade: { ru: 'Торговые документы', kk: 'Сауда құжаттары' },
  tradeDoc: { ru: 'Торговый документ', kk: 'Сауда құжаты' },
  accountingCol: { ru: 'Учёт', kk: 'Есеп' },
  REFLECTED: { ru: 'Отражён', kk: 'Көрсетілген' },
  ISSUE: { ru: 'Проблема', kk: 'Мәселе' },
  NONE: { ru: 'Не отражён', kk: 'Көрсетілмеген' },
  counterparty: { ru: 'Контрагент', kk: 'Контрагент' },
  store: { ru: 'Склад', kk: 'Қойма' },
  storeTo: { ru: 'Склад-получатель', kk: 'Алушы қойма' },
  vatIncluded: { ru: 'Цены с НДС', kk: 'Бағалар ҚҚС-пен' },
  paymentType: { ru: 'Оплата', kk: 'Төлем' },
  cashPay: { ru: 'Наличными', kk: 'Қолма-қол' },
  cardPay: { ru: 'Картой', kk: 'Картамен' },
  lossAccount: { ru: 'Счёт списания', kk: 'Есептен шығару шоты' },
  product: { ru: 'Номенклатура', kk: 'Номенклатура' },
  qty: { ru: 'Кол-во', kk: 'Саны' },
  price: { ru: 'Цена', kk: 'Бағасы' },
  discount: { ru: 'Скидка %', kk: 'Жеңілдік %' },
  vatRate: { ru: 'НДС %', kk: 'ҚҚС %' },
  vatDefault: { ru: 'по умолч.', kk: 'әдепкі' },
  createBased: { ru: 'Создать на основании', kk: 'Негізінде құру' },
  cost: { ru: 'Себестоимость', kk: 'Өзіндік құн' },
  autopilot: { ru: 'Автопилот', kk: 'Автопилот' },
  autopilotIssue: { ru: 'Документ не отражён в учёте', kk: 'Құжат есепте көрсетілмеген' },
  retry: { ru: 'Повторить', kk: 'Қайталау' },
  resync: { ru: 'Перепровести всё', kk: 'Барлығын қайта өткізу' },
  issues: { ru: 'Проблемы', kk: 'Мәселелер' },
  bankImport: { ru: 'Импорт выписки', kk: 'Үзінді көшірмені импорттау' },
  esf: { ru: 'ЭСФ', kk: 'ЭШФ' },
  closing: { ru: 'Закрытие месяца', kk: 'Айды жабу' },
  statements: { ru: 'Финансовая отчётность', kk: 'Қаржылық есептілік' },
  bankAccount: { ru: 'Банковский счёт', kk: 'Банк шоты' },
  cashbox: { ru: 'Касса', kk: 'Касса' },
  file: { ru: 'Файл', kk: 'Файл' },
  preview: { ru: 'Предпросмотр', kk: 'Алдын ала қарау' },
  load: { ru: 'Загрузить', kk: 'Жүктеу' },
  mapping: { ru: 'Сопоставление колонок', kk: 'Бағандарды сәйкестендіру' },
  stockReport: { ru: 'Остатки и себестоимость', kk: 'Қалдықтар және өзіндік құн' },
  settlements: { ru: 'Взаиморасчёты', kk: 'Өзара есеп айырысу' },
  receivable: { ru: 'Долг покупателя', kk: 'Сатып алушы қарызы' },
  advanceReceived: { ru: 'Аванс получен', kk: 'Алынған аванс' },
  payable: { ru: 'Долг поставщику', kk: 'Жеткізушіге қарыз' },
  advancePaid: { ru: 'Аванс выдан', kk: 'Берілген аванс' },
  operation: { ru: 'Вид операции', kk: 'Операция түрі' },
  purpose: { ru: 'Назначение', kk: 'Мақсаты' },
  employee: { ru: 'Сотрудник', kk: 'Қызметкер' },
  cashFlowItem: { ru: 'Статья ДДС', kk: 'АҚҚ бабы' },
  currencyAmount: { ru: 'Сумма в валюте', kk: 'Валютадағы сома' },
  toAccount: { ru: 'Куда (счёт или касса)', kk: 'Қайда (шот немесе касса)' },
  fromBank: { ru: 'С банковского счёта', kk: 'Банк шотынан' },
  quantity: { ru: 'Количество', kk: 'Саны' },
  unitCost: { ru: 'Себестоимость ед.', kk: 'Бірлік өзіндік құны' },
  toList: { ru: 'К списку', kk: 'Тізімге' },
  DRAFT: { ru: 'Черновик', kk: 'Жоба' },
  POSTED: { ru: 'Проведён', kk: 'Өткізілген' },
  CANCELLED: { ru: 'Помечен на удаление', kk: 'Жоюға белгіленген' },
}

export function useI18n() {
  function t(key: string): string {
    const e = dict[key]
    return e ? e[lang.value] : key
  }
  function setLang(l: Lang) {
    lang.value = l
    try { localStorage.setItem('fp_lang', l) } catch { /* ignore */ }
  }
  /** Название с учётом языка: nameKk при казахском, если заполнено. */
  function nm(o: any): string {
    if (!o) return ''
    return lang.value === 'kk' && o.nameKk ? o.nameKk : o.name
  }
  return { lang, t, setLang, nm }
}
