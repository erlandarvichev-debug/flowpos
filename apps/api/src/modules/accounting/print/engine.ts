// Движок печатных форм: шаблон — HTML с подстановками; ни одной строки кода из шаблона не выполняется. Общий для API
// (проверка при сохранении, тесты) и веба (отрисовка), поэтому без зависимостей.
//   {{путь.к.полю}}            — значение, экранированное как текст
//   {{путь|money}}             — 1 234,50   |date — 02.11.2026   |qty — 1,5   |words — сумма прописью (тенге, тиын)
//   |upper  |lower  |default:текст
//   {{#each lines}}…{{/each}}  — повтор; внутри поля строки, {{@n}} — номер с 1
//   {{#if путь}}…{{else}}…{{/if}}  — условие (пусто, 0, пустой список — ложь)
// Опасная разметка (script, iframe, object, обработчики on*, javascript:, внешние ресурсы) отклоняется при сохранении.

export type PrintData = Record<string, unknown>;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function lookup(scope: unknown[], path: string): unknown {
  if (path === '.' || path === 'this') return scope[scope.length - 1];
  const parts = path.split('.');
  for (let i = scope.length - 1; i >= 0; i--) {
    let v: any = scope[i];
    let ok = true;
    for (const p of parts) {
      if (v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, p)) v = v[p];
      else { ok = false; break; }
    }
    if (ok) return v;
  }
  return undefined;
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === '' || v === 0 || v === '0' || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && /^0(\.0+)?$/.test(v)));

// ── Форматы ──
export function money(v: unknown): string {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '';
  const [i, f] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${f}`;
}
function qty(v: unknown): string {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '';
  return String(+n.toFixed(3)).replace('.', ',');
}
function date(v: unknown): string {
  if (!v) return '';
  const s = typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

const ONES = [['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'], ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const plural = (n: number, f: [string, string, string]) => { const a = n % 100, b = n % 10; return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]; };
function triad(n: number, fem: boolean): string[] {
  const out: string[] = [];
  if (Math.floor(n / 100)) out.push(HUNDREDS[Math.floor(n / 100)]);
  const t = n % 100;
  if (t >= 10 && t < 20) out.push(TEENS[t - 10]);
  else { if (Math.floor(t / 10)) out.push(TENS[Math.floor(t / 10)]); if (t % 10) out.push(ONES[fem ? 1 : 0][t % 10]); }
  return out;
}
/** Целое число прописью (мужской род по умолчанию). */
export function intWords(n: number): string {
  if (n === 0) return 'ноль';
  const scales: [[string, string, string], boolean][] = [[['', '', ''], false], [['тысяча', 'тысячи', 'тысяч'], true], [['миллион', 'миллиона', 'миллионов'], false], [['миллиард', 'миллиарда', 'миллиардов'], false]];
  const parts: string[] = [];
  let i = 0;
  while (n > 0 && i < scales.length) {
    const t = n % 1000;
    if (t) parts.unshift([...triad(t, scales[i][1]), i ? plural(t, scales[i][0]) : ''].filter(Boolean).join(' '));
    n = Math.floor(n / 1000);
    i++;
  }
  return parts.join(' ');
}
/** Сумма прописью: «Одна тысяча двести тенге 50 тиын». */
export function words(v: unknown): string {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '';
  const abs = Math.abs(n);
  const tenge = Math.floor(Math.round(abs * 100) / 100);
  const tiyn = Math.round(abs * 100) % 100;
  const s = `${n < 0 ? 'минус ' : ''}${intWords(tenge)} тенге ${String(tiyn).padStart(2, '0')} тиын`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function format(v: unknown, filters: string[]): string {
  let out: unknown = v;
  for (const f of filters) {
    const [name, arg] = f.split(':');
    if (name === 'money') out = money(out);
    else if (name === 'qty') out = qty(out);
    else if (name === 'date') out = date(out);
    else if (name === 'words') out = words(out);
    else if (name === 'upper') out = String(out ?? '').toUpperCase();
    else if (name === 'lower') out = String(out ?? '').toLowerCase();
    else if (name === 'default') out = truthy(out) ? out : (arg ?? '');
    else throw new TemplateError(`Неизвестный формат «${name}»`);
  }
  if (out === undefined || out === null) return '';
  if (typeof out === 'object') return '';
  return String(out);
}

export class TemplateError extends Error {}

// ── Разбор ──
type Node = { t: 'text'; v: string } | { t: 'var'; path: string; filters: string[] } | { t: 'each'; path: string; body: Node[] } | { t: 'if'; path: string; then: Node[]; else: Node[] };
const TAG = /\{\{\s*([#/]?)([^{}]*?)\s*\}\}/g;
const PATH = /^(@n|\.|this|[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(\.[\wА-Яа-яЁё]+)*)$/;

export function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: { kind: 'each' | 'if'; node: any; target: Node[] }[] = [];
  let cur = root;
  let last = 0;
  let m: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(src))) {
    if (m.index > last) cur.push({ t: 'text', v: src.slice(last, m.index) });
    last = TAG.lastIndex;
    const [, sigil, body] = m;
    if (sigil === '#') {
      const [kw, path] = body.split(/\s+/, 2);
      if ((kw !== 'each' && kw !== 'if') || !path || !PATH.test(path)) throw new TemplateError(`Неверный блок «{{#${body}}}»`);
      const node: any = kw === 'each' ? { t: 'each', path, body: [] } : { t: 'if', path, then: [], else: [] };
      cur.push(node);
      stack.push({ kind: kw, node, target: cur });
      cur = kw === 'each' ? node.body : node.then;
    } else if (sigil === '/') {
      const top = stack.pop();
      if (!top || top.kind !== body) throw new TemplateError(`Лишнее закрытие «{{/${body}}}»`);
      cur = top.target;
    } else if (body === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if') throw new TemplateError('«{{else}}» вне блока if');
      cur = top.node.else;
    } else {
      const [path, ...filters] = body.split('|').map((x) => x.trim());
      if (!PATH.test(path)) throw new TemplateError(`Неверное поле «{{${body}}}»`);
      cur.push({ t: 'var', path, filters });
    }
  }
  if (last < src.length) cur.push({ t: 'text', v: src.slice(last) });
  if (stack.length) throw new TemplateError(`Не закрыт блок «{{#${stack[stack.length - 1].kind}}}»`);
  return root;
}

function run(nodes: Node[], scope: unknown[], out: string[]) {
  for (const n of nodes) {
    if (n.t === 'text') out.push(n.v);
    else if (n.t === 'var') out.push(esc(format(lookup(scope, n.path), n.filters)));
    else if (n.t === 'if') run(truthy(lookup(scope, n.path)) ? n.then : n.else, scope, out);
    else {
      const list = lookup(scope, n.path);
      if (!Array.isArray(list)) continue;
      list.forEach((item, i) => run(n.body, [...scope, { '@n': i + 1 }, item], out));
    }
  }
}

/** Отрисовать шаблон с данными (результат — HTML для изолированной рамки). */
export function render(src: string, data: PrintData): string {
  const out: string[] = [];
  run(parse(src), [data], out);
  return out.join('');
}

/** Проверка шаблона при сохранении: синтаксис и запрещённая разметка. Возвращает список проблем. */
export function validate(src: string): string[] {
  const problems: string[] = [];
  if (src.length > 200_000) problems.push('Шаблон длиннее 200 000 символов');
  try { parse(src); } catch (e: any) { problems.push(e.message); }
  if (/<\s*(script|iframe|frame|object|embed|base|link|meta|form)\b/i.test(src)) problems.push('Запрещены теги script, iframe, frame, object, embed, base, link, meta, form');
  if (/\son[a-z]+\s*=/i.test(src)) problems.push('Запрещены обработчики событий (onclick и т. п.)');
  if (/javascript\s*:/i.test(src)) problems.push('Запрещены ссылки javascript:');
  if (/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(src) || /url\(\s*["']?\s*(https?:)?\/\//i.test(src) || /@import/i.test(src)) problems.push('Внешние ресурсы запрещены — картинки только data:');
  return problems;
}

/** Поля данных для подсказки в конструкторе: пути до значений (у списков — поля первой строки). */
export function fieldPaths(data: PrintData, prefix = ''): { path: string; sample: string; list?: boolean }[] {
  const out: { path: string; sample: string; list?: boolean }[] = [];
  for (const [k, v] of Object.entries(data)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out.push({ path: p, sample: `${v.length} стр.`, list: true });
      if (v[0] && typeof v[0] === 'object') for (const f of fieldPaths(v[0] as PrintData)) out.push({ path: `${p}[].${f.path}`, sample: f.sample });
    } else if (v && typeof v === 'object') out.push(...fieldPaths(v as PrintData, p));
    else out.push({ path: p, sample: v === null || v === undefined ? '' : String(v) });
  }
  return out;
}

/** Обёртка для изолированной рамки: запрет скриптов и внешних загрузок, стили печати A4. */
export function frameDocument(body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
    + `<style>@page{size:A4;margin:12mm}body{font-family:Arial,'DejaVu Sans',sans-serif;font-size:10pt;color:#000;margin:0}`
    + `table{border-collapse:collapse}td,th{vertical-align:top}.page-break{page-break-after:always}</style></head><body>${body}</body></html>`;
}
