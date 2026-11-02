// FP-039: пакеты налоговых правил РК. Каждая версия — неизменный набор параметров с источниками и оговорками
// (что не сверено с текстом НПА на adilet.zan.kz). Новая редакция закона — новая версия пакета, старая остаётся
// для пересчёта прошлых периодов. Значения — docs/accounting/NORMATIVE_REGISTRY.md (проверка 18.10.2026) и
// payroll/kz-payroll.ts (тексты кодексов прочитаны 23.10.2026).
import { createHash } from 'crypto';
import { KZ_PAYROLL_2026 } from '../payroll/kz-payroll';

export interface TaxSource { topic: string; npa: string; articles?: string; url?: string; confidence: 'ОФ' | 'ВТ' | 'НП' }
export interface TaxPackDef {
  code: string;
  version: string;
  validFrom: string;
  validTo: string | null;
  params: {
    mrp: number;
    mzp: number;
    vat: {
      standardRate: number;
      reducedRates: { rate: number; scope: string }[];
      zeroRate: string;
      registrationThresholdMrp: number;
      period: 'QUARTER';
      filing: string;
      payment: string;
    };
    cit: { rate: number; specialRates: { rate: number; scope: string }[] };
    simplified: { form: string; rate: number; maslikhatMin: number; maslikhatMax: number; incomeLimitMrp: number; period: 'HALF_YEAR'; filing: string; payment: string };
    payroll: Omit<typeof KZ_PAYROLL_2026, 'sources'>;
  };
  sources: TaxSource[];
  /** Пункты, которые требуют сверки с текстом НПА. Утверждающий подтверждает каждый явно. */
  unverified: { key: string; text: string }[];
}

const { sources: _payrollSources, ...payroll2026 } = KZ_PAYROLL_2026;

export const KZ_2026_1: TaxPackDef = {
  code: 'KZ',
  version: '2026.1',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  params: {
    mrp: 4325,
    mzp: 85000,
    vat: {
      standardRate: 16,
      reducedRates: [
        { rate: 5, scope: 'лекарственные средства, медицинские изделия, технические средства для лиц с инвалидностью, медицинские услуги' },
        { rate: 10, scope: 'отечественные периодические печатные издания' },
      ],
      zeroRate: 'экспорт товаров, международные перевозки',
      registrationThresholdMrp: 10000,
      period: 'QUARTER',
      filing: 'ФНО 300.00: с 15-го числа месяца после квартала до 15-го числа второго месяца после квартала',
      payment: 'до 25-го числа второго месяца после квартала',
    },
    cit: {
      rate: 20,
      specialRates: [
        { rate: 25, scope: 'банки (кроме доходов от кредитования бизнеса), игорный бизнес' },
        { rate: 5, scope: 'социальная сфера (образование, медицина) в 2026 году' },
        { rate: 3, scope: 'сельхозпроизводители' },
        { rate: 6, scope: 'сельхозкооперативы' },
      ],
    },
    simplified: {
      form: '910.00', rate: 4, maslikhatMin: 2, maslikhatMax: 6, incomeLimitMrp: 600000, period: 'HALF_YEAR',
      filing: 'до 15-го числа второго месяца после полугодия', payment: 'до 25-го числа второго месяца после полугодия',
    },
    payroll: payroll2026,
  },
  sources: [
    { topic: 'Налоговый кодекс', npa: 'Кодекс РК от 18.07.2025 № 214-VIII «О налогах и других обязательных платежах в бюджет», с 01.01.2026', url: 'https://prg.kz/m/amp/document/37777973', confidence: 'ВТ' },
    { topic: 'НДС: ставка 16%', npa: 'НК РК № 214-VIII', articles: 'ст. 503', url: 'https://pro1c.kz/news/zakonodatelstvo/izmeneniya-po-nds-s-1-yanvarya-2026-goda/', confidence: 'ВТ' },
    { topic: 'НДС: порог регистрации 10 000 МРП', npa: 'НК РК № 214-VIII', articles: 'ст. 99', confidence: 'ВТ' },
    { topic: 'НДС: период и сроки 300.00', npa: 'НК РК № 214-VIII', articles: 'ст. 505', confidence: 'ВТ' },
    { topic: 'НДС: зачёт по дате получения, отражение в ИС ЭСФ до подачи 300.00', npa: 'НК РК № 214-VIII', articles: 'ст. 480–481', confidence: 'ВТ' },
    { topic: 'КПН 20% и особые ставки', npa: 'НК РК № 214-VIII', url: 'https://pro1c.kz', confidence: 'ВТ' },
    { topic: 'Упрощённая декларация 4% (2–6% по решению маслихата), лимит 600 000 МРП, полугодие', npa: 'НК РК № 214-VIII', url: 'https://mybuh.kz/news/uproshchenka-2026-chto-menyaetsya/', confidence: 'ВТ' },
    { topic: 'Формы налоговой отчётности 2026', npa: 'Приказ МФ РК от 12.11.2025 № 695', url: 'https://uchet.kz/news/novye-formy-nalogovoy-otchetnosti-i-poryadok-ikh-predstavleniya-na-2026-god/', confidence: 'ВТ' },
    { topic: 'МРП 4 325, МЗП 85 000', npa: 'Закон о республиканском бюджете на 2026–2028 годы (08.12.2025)', url: 'https://kapital.kz/gosudarstvo/143213/mrp-mzp-i-drugie-raschetnye-pokazateli-na-2026-god.html', confidence: 'ВТ' },
    ...KZ_PAYROLL_2026.sources.map((s) => ({ topic: 'Зарплатные налоги и платежи', npa: s, confidence: 'ВТ' as const })),
  ],
  unverified: [
    { key: 'vat.reduced5.period', text: 'Ставка НДС 5%: только 2026 год или 2026–2027 — источники расходятся (ст. 503 НК)' },
    { key: 'vat.zero', text: 'Ставка 0% (экспорт, международные перевозки) отдельно не перепроверена' },
    { key: 'vat.creditLimits', text: 'Ограничения зачёта НДС (пропорция, оплата поставщику) — нужен полный текст ст. 480–486 НК' },
    { key: 'cit.special', text: 'Особые ставки КПН (5%, 3%, 6%) взяты из поисковой выдачи' },
    { key: 'payroll.sn.min', text: 'Минимальный объект СН 14 МРП — сверить ст. 556–558 НК' },
    { key: 'payroll.opvr.exceptions', text: 'Перечень освобождений от ОПВР — сверить с Социальным кодексом' },
    { key: 'all.secondary', text: 'Все значения подтверждены вторичными источниками — сверить с текстом НК на adilet.zan.kz' },
  ],
};

/** Встроенные версии, от старых к новым. */
export const BUILTIN_PACKS: TaxPackDef[] = [KZ_2026_1];

/** Канонический JSON (ключи по алфавиту) — хэш не зависит от порядка ключей в jsonb. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const hashOf = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export const packHash = (p: Pick<TaxPackDef, 'code' | 'version' | 'validFrom' | 'validTo' | 'params' | 'sources' | 'unverified'>) =>
  hashOf({ code: p.code, version: p.version, validFrom: p.validFrom, validTo: p.validTo, params: p.params, sources: p.sources, unverified: p.unverified });
