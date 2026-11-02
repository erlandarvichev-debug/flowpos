import { render, validate, words, intWords, money, fieldPaths, TemplateError } from './engine';

describe('движок печатных форм', () => {
  it('подстановки, форматы, экранирование', () => {
    expect(render('<b>{{org.name}}</b> {{sum|money}} от {{date|date}} {{qty|qty}}', { org: { name: 'ТОО «А&Б» <x>' }, sum: '1234567.5', date: '2026-11-02', qty: '1.500' }))
      .toBe('<b>ТОО «А&amp;Б» &lt;x&gt;</b> 1 234 567,50 от 02.11.2026 1,5');
    expect(render('{{a|default:нет}}|{{b|upper}}', { a: '', b: 'abc' })).toBe('нет|ABC');
    expect(render('{{missing}}|{{obj}}', { obj: { x: 1 } })).toBe('|');
    expect(money('-5')).toBe('−5,00');
  });

  it('повтор строк с номером, вложенные поля и поля снаружи; условия', () => {
    const t = '{{#each lines}}{{@n}}. {{name}} × {{qty}} ({{cur}});{{/each}}{{#if vat}}НДС {{vat}}{{else}}без НДС{{/if}}';
    expect(render(t, { cur: 'KZT', lines: [{ name: 'A', qty: 1 }, { name: 'B', qty: 2 }], vat: '0.00' })).toBe('1. A × 1 (KZT);2. B × 2 (KZT);без НДС');
    expect(render('{{#if list}}есть{{/if}}{{#each list}}x{{/each}}', { list: [] })).toBe('');
  });

  it('сумма прописью', () => {
    expect(intWords(0)).toBe('ноль');
    expect(intWords(1)).toBe('один');
    expect(intWords(21_001)).toBe('двадцать одна тысяча один');
    expect(intWords(2_342_115)).toBe('два миллиона триста сорок две тысячи сто пятнадцать');
    expect(intWords(1_000_000)).toBe('один миллион');
    expect(intWords(12_000)).toBe('двенадцать тысяч');
    expect(words('1200.5')).toBe('Одна тысяча двести тенге 50 тиын'.replace('Одна', 'Одна'));
    expect(words('101')).toBe('Сто один тенге 00 тиын');
    expect(words('0.99')).toBe('Ноль тенге 99 тиын');
  });

  it('ошибки шаблона и запрещённая разметка', () => {
    expect(() => render('{{#each x}}', {})).toThrow(TemplateError);
    expect(() => render('{{/if}}', {})).toThrow(/Лишнее закрытие/);
    expect(() => render('{{a|eval}}', { a: 1 })).toThrow(/Неизвестный формат/);
    expect(() => render('{{constructor.constructor}}', {})).not.toThrow();
    expect(render('{{constructor.name}}', {})).toBe('');
    expect(validate('<p>{{a}}</p>')).toEqual([]);
    for (const bad of ['<script>x</script>', '<img src="x" onerror="alert(1)">', '<a href="javascript:x">', '<img src="https://evil/x?{{a}}">', '<div style="background:url(//evil)">', '<iframe src=x>', '<style>@import "x"</style>'])
      expect(validate(bad).length).toBeGreaterThan(0);
    expect(validate('{{#if a}}')).toEqual(['Не закрыт блок «{{#if}}»']);
  });

  it('поля для конструктора', () => {
    expect(fieldPaths({ org: { name: 'A' }, lines: [{ n: 1, name: 'X' }] })).toEqual([
      { path: 'org.name', sample: 'A' }, { path: 'lines', sample: '1 стр.', list: true }, { path: 'lines[].n', sample: '1' }, { path: 'lines[].name', sample: 'X' },
    ]);
  });
});
