// FP-054: описания форм налоговой отчётности 2026 по приказу МФ РК от 12.11.2025 № 695 (текст и бланки — cdb.kz,
// прочитаны 02.11.2026): 300.00 — приложение 12, 910.00 и 910.01 — приложение 27. Строки считаются только из
// зафиксированного регистра и параметров пакета правил; то, чего FlowPOS не ведёт (импорт, нерезиденты, освобождённые
// обороты, раздельный учёт), — нули с предупреждением, а не догадки.
import { Prisma } from '@prisma/client';
import { D } from '../common/money';
import { TaxPackDef } from './rule-packs';

type Dec = Prisma.Decimal;
export interface DeclLine { code: string; name: string; value: string; formula?: string; source?: string }
/** text — условие (что должно выполняться); hint — что делать, если не выполнено. */
export interface DeclCheck { code: string; ok: boolean; severity: 'ERROR' | 'WARNING'; text: string; hint?: string }
export interface FormBuildInput { register: any; pack: TaxPackDef; period: string; year: number; policy: { vatPayer?: boolean; taxRegime?: string; params?: any } | null }
export interface FormDef {
  form: string;
  title: string;
  periods: string[];
  registerKind: string;
  registerPeriod: (period: string) => string;
  registerLink: string;
  /** Структура строк сверена с текстом формы (приказ № 695). */
  verified: boolean;
  note?: string;
  build(input: FormBuildInput): { header: Record<string, unknown>; lines: DeclLine[]; checks: DeclCheck[] };
}

const money = (v: Dec) => v.toFixed(2);
const sum = (xs: Dec[]) => xs.reduce((s, x) => s.plus(x), new D(0));
const RETAIL = new Set(['RETAIL_DEMAND', 'RETAIL_RETURN']);
const RETURNS = new Set(['SALES_RETURN', 'RETAIL_RETURN']);
const ORDER_695 = 'Приказ МФ РК от 12.11.2025 № 695, прил. ';

// ── 300.00 Декларация по НДС ──
const F300: FormDef = {
  form: '300.00',
  title: 'Декларация по НДС',
  periods: ['Q1', 'Q2', 'Q3', 'Q4'],
  registerKind: 'VAT',
  registerPeriod: (p) => p,
  registerLink: '/tax/vat',
  verified: true,
  note: `${ORDER_695}12. Метод отнесения в зачёт — пропорциональный. Импорт, услуги нерезидентов, освобождённые обороты и обороты вне РК FlowPOS пока не ведёт — эти строки 0.`,
  build({ register: r }) {
    // Обороты по ставкам: реализация с ЭСФ (I), розница без счетов-фактур (II), возвраты — корректировка оборота (003, ст. 464).
    const by = { I: new Map<string, { a: Dec; b: Dec }>(), II: { a: new D(0), b: new D(0) }, ret: { a: new D(0), b: new D(0) }, zero: new D(0) };
    for (const row of r.output.rows as any[]) {
      for (const x of row.byRate as { rate: string; base: string; vat: string }[]) {
        const a = new D(x.base), b = new D(x.vat);
        if (RETURNS.has(row.docType)) { by.ret.a = by.ret.a.plus(a); by.ret.b = by.ret.b.plus(b); continue; }
        if (new D(x.rate).isZero()) { by.zero = by.zero.plus(a); continue; }
        if (RETAIL.has(row.docType)) { by.II.a = by.II.a.plus(a); by.II.b = by.II.b.plus(b); continue; }
        const cur = by.I.get(x.rate) ?? { a: new D(0), b: new D(0) };
        by.I.set(x.rate, { a: cur.a.plus(a), b: cur.b.plus(b) });
      }
    }
    const pick = (rate: string) => by.I.get(rate) ?? { a: new D(0), b: new D(0) };
    const i1 = pick('16.00'), i2 = pick('10.00'), i3 = pick('5.00');
    const other = [...by.I].filter(([k]) => !['16.00', '10.00', '5.00'].includes(k));
    const i4 = { a: sum(other.map(([, v]) => v.a)), b: sum(other.map(([, v]) => v.b)) };
    const IA = sum([i1.a, i2.a, i3.a, i4.a]), IB = sum([i1.b, i2.b, i3.b, i4.b]);
    const l001A = IA.plus(by.II.a), l001B = IB.plus(by.II.b);
    const l002 = by.zero, l003A = by.ret.a, l003B = by.ret.b, l004 = new D(0), l005 = new D(0);
    const l006 = sum([l001A, l002, l003A, l004, l005]);
    const l006I = sum([l001A, l002, l003A]);
    const l007 = l006.isZero() ? new D(0) : l006I.div(l006).times(100).toDecimalPlaces(2);
    const l008 = l006I.isZero() ? new D(0) : l002.div(l006I).times(100).toDecimalPlaces(2);
    const l012 = l001B.plus(l003B);

    const inRows = r.input.rows as any[];
    const credit = inRows.filter((x) => x.kind !== 'NON_CREDITABLE');
    const nonCred = inRows.filter((x) => x.kind === 'NON_CREDITABLE');
    const l013A = sum(credit.map((x) => new D(x.base ?? 0))), l013B = sum(credit.map((x) => new D(x.amount)));
    const l015A = sum(nonCred.map((x) => new D(x.base ?? 0))), l015B = sum(nonCred.map((x) => new D(x.amount)));
    const l021 = l013A.plus(l015A);
    const l023 = l013B;
    // Пропорциональный метод: 025 I = 023 × 007; нет оборота — переносится 023.
    const l025 = l006.isZero() ? l023 : l023.times(l007).div(100).toDecimalPlaces(2);
    const l026 = l023.minus(l025);
    const diff = l012.minus(l025);
    const l030I = diff.gt(0) ? diff : new D(0);
    const l030II = diff.lt(0) ? diff.neg() : new D(0);

    const L = (code: string, name: string, v: Dec, formula?: string, source?: string): DeclLine => ({ code, name, value: money(v), formula, source });
    const lines: DeclLine[] = [
      L('300.00.001 A', 'Облагаемый оборот (кроме нулевой ставки)', l001A, '001 I A + 001 II A'),
      L('300.00.001 B', 'НДС по облагаемому обороту', l001B, '001 I B + 001 II B'),
      L('300.00.001 I A', 'Оборот с выпиской счетов-фактур', IA, 'I 1 A + I 2 A + I 3 A + I 4 A'),
      L('300.00.001 I B', 'НДС по обороту с выпиской счетов-фактур', IB, 'I 1 B + I 2 B + I 3 B + I 4 B'),
      L('300.00.001 I 1 A', 'по ставке 16% — оборот', i1.a, undefined, 'регистр НДС: реализации'),
      L('300.00.001 I 1 B', 'по ставке 16% — НДС', i1.b, undefined, 'регистр НДС: реализации'),
      L('300.00.001 I 2 A', 'по ставке 10% — оборот', i2.a),
      L('300.00.001 I 2 B', 'по ставке 10% — НДС', i2.b),
      L('300.00.001 I 3 A', 'по ставке 5% — оборот', i3.a),
      L('300.00.001 I 3 B', 'по ставке 5% — НДС', i3.b),
      L('300.00.001 I 4 A', `по иной ставке — оборот${other.length ? ` (${other.map(([k]) => Number(k) + '%').join(', ')})` : ''}`, i4.a),
      L('300.00.001 I 4 B', 'по иной ставке — НДС', i4.b),
      L('300.00.001 II A', 'Оборот без выписки счетов-фактур', by.II.a, undefined, 'регистр НДС: розничные чеки'),
      L('300.00.001 II B', 'НДС по обороту без выписки счетов-фактур', by.II.b, undefined, 'регистр НДС: розничные чеки'),
      L('300.00.002', 'Оборот по нулевой ставке', l002, undefined, 'регистр НДС: ставка 0%'),
      L('300.00.003 A', 'Корректировка облагаемого оборота (ст. 464)', l003A, undefined, 'регистр НДС: возвраты от покупателей'),
      L('300.00.003 B', 'Корректировка НДС по облагаемому обороту', l003B, undefined, 'регистр НДС: возвраты от покупателей'),
      L('300.00.004', 'Оборот, местом реализации которого не является РК', l004, undefined, 'не ведётся'),
      L('300.00.005', 'Освобождённый оборот', l005, undefined, 'не ведётся'),
      L('300.00.006', 'Общий оборот', l006, '001 A + 002 + 003 A + 004 + 005'),
      L('300.00.006 I', 'Облагаемый оборот', l006I, '001 A + 002 + 003 A'),
      L('300.00.007', 'Доля облагаемого оборота в общем, %', l007, '006 I / 006 × 100'),
      L('300.00.008', 'Доля оборота по нулевой ставке в облагаемом, %', l008, '002 / 006 I × 100'),
      L('300.00.012', 'Всего начислено НДС', l012, '001 B + 003 B + 010 + 011'),
      L('300.00.013 A', 'Приобретено в РК с НДС — стоимость', l013A, '013 I A + 013 II A', 'регистр зачёта по ЭСФ'),
      L('300.00.013 B', 'Приобретено в РК с НДС — НДС', l013B, '013 I B + 013 II B', 'регистр зачёта по ЭСФ'),
      L('300.00.013 I A', 'по счетам-фактурам — стоимость', l013A),
      L('300.00.013 I B', 'по счетам-фактурам — НДС', l013B),
      L('300.00.015 A', 'Приобретено без НДС / НДС не относится в зачёт (ст. 482, 483) — стоимость', l015A, undefined, 'регистр зачёта: «не в зачёт»'),
      L('300.00.015 B', 'НДС, не относимый в зачёт (ст. 482, 483)', l015B, undefined, 'регистр зачёта: «не в зачёт»'),
      L('300.00.021', 'Всего приобретено', l021, '013 A + 014 A + 015 + 016 I A + 016 II A + 017 + 020 A + 029 A'),
      L('300.00.023', 'НДС, относимый в зачёт', l023, '013 B + 014 B + 016 I B + 016 II B + 019 + 020 B + 022'),
      L('300.00.025 I B', 'Разрешённый зачёт (пропорциональный метод)', l025, '023 × 007; нет оборота — 023'),
      L('300.00.026 I', 'НДС, не разрешённый к зачёту', l026, '023 − 025 I'),
      L('300.00.030 I', 'НДС к уплате', l030I, '012 − 025 I − 029 B − 025 IV, если > 0'),
      L('300.00.030 II', 'Превышение НДС, относимого в зачёт, над начисленным', l030II, '025 I + 029 B − 012, если > 0'),
    ];
    const reg012 = new D(r.output.vat);
    const checks: DeclCheck[] = [
      { code: 'C1', severity: 'ERROR', ok: l012.eq(reg012), text: `300.00.012 (${money(l012)}) = НДС начислен по регистру (${money(reg012)})` },
      { code: 'C2', severity: 'ERROR', ok: l013B.eq(new D(r.input.credit)), text: `300.00.013 B (${money(l013B)}) = зачёт по регистру (${r.input.credit})` },
      { code: 'C3', severity: 'ERROR', ok: !(l030I.gt(0) && l030II.gt(0)), text: '300.00.030 I и 300.00.030 II не заполняются одновременно' },
      { code: 'C4', severity: 'ERROR', ok: l006.eq(sum([l001A, l002, l003A, l004, l005])), text: '300.00.006 = 001 A + 002 + 003 A + 004 + 005' },
      { code: 'W1', severity: 'WARNING', ok: other.length === 0, text: 'Оборотов по иной ставке (300.00.001 I 4) нет', hint: 'проверьте ставку в документах' },
      { code: 'W2', severity: 'WARNING', ok: (r.issues ?? []).every((i: any) => i.severity !== 'WARNING'), text: 'В регистре НДС нет предупреждений', hint: 'проверьте их перед сдачей' },
    ];
    return { header: { vatCreditMethod: 'PROPORTIONAL', currency: 'KZT' }, lines, checks };
  },
};

// ── 910.00 Упрощённая декларация (СНР) ──
const F910: FormDef = {
  form: '910.00',
  title: 'Упрощённая декларация',
  periods: ['H1', 'H2'],
  registerKind: 'SIMPLIFIED',
  registerPeriod: (p) => p,
  registerLink: '/tax/simplified',
  verified: true,
  note: `${ORDER_695}27. Социальные платежи ИП за себя (910.00.005–010) и уменьшение по п. 1 ст. 724 (910.00.002) FlowPOS пока не считает — 0 с предупреждением. Ставка 8% (910.01 графа G) не применяется.`,
  build({ register: r, pack, policy }) {
    const params = policy?.params ?? {};
    const rate = new D(params.simplifiedRate ?? pack.params.simplified.rate);
    const income = new D(r.income);
    const l002 = new D(0);
    const l003 = income.minus(l002);
    const l004 = l003.times(rate).div(100).toDecimalPlaces(2);
    const reductionThreshold = new D(pack.params.mrp).times(24000);
    const L = (code: string, name: string, v: Dec, formula?: string, source?: string): DeclLine => ({ code, name, value: money(v), formula, source });
    const lines: DeclLine[] = [
      L('910.00.001', 'Доход (ст. 724 НК)', income, 'итог графы H формы 910.01', 'регистр доходов упрощёнки'),
      L('910.00.002', 'Сумма уменьшения по п. 1 ст. 724', l002, '= 910.01.001', 'не рассчитывается'),
      L('910.00.003', 'Доход для исчисления ИПН (КПН)', l003, '001 − 002'),
      L('910.00.004', 'ИПН (КПН) к уплате', l004, `003 × ${rate.toString()}% (910.01 графа L)`),
      L('910.01.001', 'Сумма уменьшения по п. 1 ст. 724', l002),
      L('910.01 G', 'Ставка, %', rate),
      L('910.01 H', 'Доход', income),
      L('910.01 K', 'Доход для исчисления ИПН (КПН)', l003, 'H − J'),
      L('910.01 L', 'ИПН (КПН)', l004, 'K × G'),
    ];
    const checks: DeclCheck[] = [
      { code: 'C1', severity: 'ERROR', ok: rate.gte(pack.params.simplified.maslikhatMin) && rate.lte(pack.params.simplified.maslikhatMax), text: `Ставка ${rate}% в пределах ${pack.params.simplified.maslikhatMin}–${pack.params.simplified.maslikhatMax}% (решение маслихата)` },
      { code: 'C2', severity: 'ERROR', ok: (r.issues ?? []).every((i: any) => i.code !== 'LIMIT_EXCEEDED'), text: `Доход не превышает предел ${pack.params.simplified.incomeLimitMrp} МРП` },
      { code: 'C3', severity: 'ERROR', ok: l003.eq(income.minus(l002)), text: '910.00.003 = 910.00.001 − 910.00.002' },
      { code: 'W1', severity: 'WARNING', ok: income.lte(reductionThreshold), text: 'Доход не превышает 24 000 МРП', hint: 'возможно уменьшение по п. 1 ст. 724 (910.00.002) — FlowPOS его не считает, заполните вручную' },
      { code: 'W2', severity: 'WARNING', ok: r.rule?.status !== 'METHODOLOGIST_REVIEW', text: 'Состав дохода утверждён методологом', hint: 'правило-черновик — проверьте регистр доходов' },
    ];
    return { header: { legalForm: params.legalForm ?? null, currency: 'KZT', rate: rate.toString() }, lines, checks };
  },
};

export const FORMS: Record<string, FormDef> = { [F300.form]: F300, [F910.form]: F910 };
