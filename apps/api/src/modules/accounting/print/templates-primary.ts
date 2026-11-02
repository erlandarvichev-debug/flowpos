// Формы первичных учётных документов по приказу МФ РК от 20.12.2012 № 562 (рег. № 8265; текст с изменениями на
// 28.03.2018 — zakon.uchet.kz V1200008265, прочитан 02.11.2026): З-2 — прил. 26 (ред. № 402), Р-1 — прил. 50
// (ред. № 458), КО-1 — прил. 1, КО-2 — прил. 2. Надписи — дословно по бланку. Проект изменений 2026 года
// («теңге», полное «Индивидуальный идентификационный номер/…», «Место печати») не подтверждён как принятый —
// при принятии поправьте шаблон в конструкторе.
export interface PrimaryForm { name: string; html: string; source: string }

const CSS = `<style>
.p{font-size:9pt}.p .r{text-align:right}.p .c{text-align:center}.p .fr{text-align:right;font-size:8pt}
.p table.g{width:100%;border-collapse:collapse}.p table.g th,.p table.g td{border:1px solid #000;padding:2px 4px;font-size:8.5pt}
.p table.g th{font-weight:normal;text-align:center}.p .t{font-weight:bold;text-align:center;font-size:11pt;margin:8px 0}
.p .u{border-bottom:1px solid #000;display:inline-block;min-width:140px;padding:0 4px}.p .cap{font-size:7pt;color:#333;text-align:center}
.p .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.p .box td{border:1px solid #000;padding:2px 8px;text-align:center}
.p .sg{display:flex;justify-content:space-between;gap:24px;margin-top:14px}.p .sg>div{flex:1}.p .sg p{margin:6px 0}
</style>`;

const HEAD = (form: string) => `<div class="fr">Форма ${form}</div>
<div class="hd"><div>Организация (индивидуальный предприниматель) <span class="u">{{org.name}}</span></div>
<table class="box"><tr><td>ИИН/БИН</td></tr><tr><td><b>{{org.bin}}</b></td></tr></table></div>`;
const NUMDATE = `<table class="box" style="margin-left:auto"><tr><td>Номер документа</td><td>Дата составления</td></tr><tr><td><b>{{doc.number}}</b></td><td><b>{{doc.date|date}}</b></td></tr></table>`;

export const Z2: PrimaryForm = {
  name: 'Накладная на отпуск запасов на сторону (З-2)',
  source: 'Приказ МФ РК от 20.12.2012 № 562, приложение 26 (ред. приказа № 402 от 19.08.2013)',
  html: `${CSS}<div class="p">${HEAD('З-2')}
${NUMDATE}
<div class="t">Накладная на отпуск запасов на сторону</div>
<table class="g">
<tr><th>Организация (индивидуальный предприниматель) - отправитель</th><th>Организация (индивидуальный предприниматель)- получатель</th><th>Ответственный за поставку (Ф.И.О.)</th><th>Транспортная организация</th><th>Товарно-транспортная накладная (номер, дата)</th></tr>
<tr><td>{{supplier.name}}</td><td>{{buyer.name}}</td><td></td><td></td><td></td></tr>
</table><br>
<table class="g">
<tr><th rowspan="2">Номер по порядку</th><th rowspan="2">Наименование, характеристика</th><th rowspan="2">Номенкла-турный номер</th><th rowspan="2">Единица измерения</th><th colspan="2">Количество</th><th rowspan="2">Цена за единицу, в тенге</th><th rowspan="2">Сумма с НДС, в тенге</th><th rowspan="2">Сумма НДС, в тенге</th></tr>
<tr><th>подлежит отпуску</th><th>отпущено</th></tr>
<tr><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th><th>9</th></tr>
{{#each lines}}<tr><td class="c">{{@n}}</td><td>{{name}}</td><td>{{code}}</td><td class="c">{{unit}}</td><td class="r">{{qty|qty}}</td><td class="r">{{qty|qty}}</td><td class="r">{{price|money}}</td><td class="r">{{amount|money}}</td><td class="r">{{vat|money}}</td></tr>{{/each}}
<tr><td colspan="4" class="r"><b>Итого</b></td><td class="r">{{totals.qty|qty}}</td><td class="r">{{totals.qty|qty}}</td><td class="c">х</td><td class="r">{{totals.amount|money}}</td><td class="r">{{totals.vat|money}}</td></tr>
</table>
<p>Всего отпущено количество запасов (прописью) <span class="u">{{qtyWords}}</span> на сумму (прописью), в тенге <span class="u">{{amountWords}}</span></p>
<div class="sg"><div>
<p>Отпуск разрешил <span class="u">&nbsp;</span>/<span class="u">&nbsp;</span>/<span class="u">{{org.director}}</span></p><div class="cap">должность &nbsp;&nbsp;&nbsp;&nbsp; подпись &nbsp;&nbsp;&nbsp;&nbsp; расшифровка подписи</div>
<p>Главный бухгалтер <span class="u">&nbsp;</span>/<span class="u">{{org.accountant}}</span></p><div class="cap">подпись &nbsp;&nbsp;&nbsp;&nbsp; расшифровка подписи</div>
<p>М.П.</p>
<p>Отпустил <span class="u">&nbsp;</span>/<span class="u">&nbsp;</span></p><div class="cap">подпись &nbsp;&nbsp;&nbsp;&nbsp; расшифровка подписи</div>
</div><div>
<p>По доверенности №<span class="u">&nbsp;</span> от "____"____________ 20 _____ года</p>
<p>выданной <span class="u" style="min-width:260px">&nbsp;</span></p>
<p>Запасы получил <span class="u">&nbsp;</span>/<span class="u">&nbsp;</span></p><div class="cap">подпись &nbsp;&nbsp;&nbsp;&nbsp; расшифровка подписи</div>
</div></div></div>`,
};

export const R1: PrimaryForm = {
  name: 'Акт выполненных работ (оказанных услуг) (Р-1)',
  source: 'Приказ МФ РК от 20.12.2012 № 562, приложение 50 (ред. приказа № 458 от 27.10.2014)',
  html: `${CSS}<div class="p"><div class="fr">Форма Р-1</div>
<table class="g"><tr><td style="border:none">
<p>Заказчик <span class="u" style="min-width:420px">{{buyer.name}}{{#if buyer.address}}, {{buyer.address}}{{/if}}</span></p><div class="cap">полное наименование, адрес, данные о средствах связи</div>
<p>Исполнитель <span class="u" style="min-width:400px">{{supplier.name}}{{#if supplier.address}}, {{supplier.address}}{{/if}}{{#if org.phone}}, {{org.phone}}{{/if}}</span></p><div class="cap">полное наименование, адрес, данные о средствах связи</div>
<p>Договор (контракт) {{#if contract}}№ {{contract.number}} от {{contract.date|date}}{{else}}___№___ "___"________ 20 __ г.{{/if}}</p>
</td><td style="width:150px"><div class="c">ИИН/БИН</div><p class="c"><b>{{buyer.bin}}</b></p><p class="c"><b>{{supplier.bin}}</b></p></td></tr></table>
<div class="hd" style="margin-top:8px"><div class="t" style="flex:1">АКТ ВЫПОЛНЕННЫХ РАБОТ (ОКАЗАННЫХ УСЛУГ)*</div>${NUMDATE}</div>
<table class="g">
<tr><th rowspan="2">Номер по порядку</th><th rowspan="2">Наименование работ (услуг) (в разрезе их подвидов в соответствии с технической спецификацией, заданием, графиком выполнения работ (услуг) при их наличии)</th><th rowspan="2">Дата выполнения работ (оказания услуг)**</th><th rowspan="2">Сведения об отчете о научных исследованиях, маркетинговых, консультационных и прочих услугах (дата, номер, количество страниц) (при их наличии)***</th><th rowspan="2">Единица измерения</th><th colspan="3">Выполнено работ (оказано услуг)</th></tr>
<tr><th>количество</th><th>цена за единицу</th><th>стоимость</th></tr>
<tr><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th></tr>
{{#each lines}}<tr><td class="c">{{@n}}</td><td>{{name}}</td><td class="c">{{doc.date|date}}</td><td></td><td class="c">{{unit}}</td><td class="r">{{qty|qty}}</td><td class="r">{{price|money}}</td><td class="r">{{amount|money}}</td></tr>{{/each}}
<tr><td></td><td></td><td></td><td></td><td class="r"><b>Итого</b></td><td class="r">{{totals.qty|qty}}</td><td class="c">х</td><td class="r">{{totals.amount|money}}</td></tr>
</table>
<p>Сведения об использовании запасов, полученных от заказчика <span class="u" style="min-width:300px">&nbsp;</span></p><div class="cap">наименование, количество, стоимость</div>
<p>Приложение: Перечень документации, в том числе отчет(ы) о маркетинговых, научных исследованиях, консультационных и прочих услугах (обязательны при его (их) наличии) на _______________ страниц</p>
<div class="sg"><div>
<p>Сдал (Исполнитель) <span class="u">&nbsp;</span>/<span class="u">&nbsp;</span>/<span class="u">{{org.director}}</span></p><div class="cap">должность &nbsp;&nbsp; подпись &nbsp;&nbsp; расшифровка подписи</div><p>М.П.</p>
</div><div>
<p>Принял (Заказчик) <span class="u">&nbsp;</span>/<span class="u">&nbsp;</span>/<span class="u">&nbsp;</span></p><div class="cap">должность &nbsp;&nbsp; подпись &nbsp;&nbsp; расшифровка подписи</div>
<p>Дата подписания (принятия) работ (услуг) <span class="u">&nbsp;</span></p><p>М.П.</p>
</div></div>
<p class="cap" style="text-align:left">*Применяется для приемки-передачи выполненных работ (оказанных услуг), за исключением строительно-монтажных работ.<br>
**Заполняется в случае, если даты выполненных работ (оказанных услуг) приходятся на различные периоды, а также в случае, если даты выполнения работ (оказания услуг) и даты подписания (принятия) работ (услуг) различны.<br>
***Заполняется в случае наличия отчета о научных исследованиях, маркетинговых, консультационных и прочих услугах.</p>
</div>`,
};

export const KO1: PrimaryForm = {
  name: 'Приходный кассовый ордер (КО-1)',
  source: 'Приказ МФ РК от 20.12.2012 № 562, приложение 1',
  html: `${CSS}<div class="p"><div style="display:flex;gap:10px">
<div style="flex:3">${HEAD('КО-1')}
${NUMDATE}
<div class="t">ПРИХОДНЫЙ КАССОВЫЙ ОРДЕР</div>
<table class="g">
<tr><th rowspan="2">Дебет</th><th>Кредит</th><th rowspan="2">Сумма, в тенге</th><th colspan="2">Код целевого назначения</th></tr>
<tr><th>корреспондирующий счет</th><th></th><th></th></tr>
<tr><td class="c">{{entry.debit}}</td><td class="c">{{entry.credit}}</td><td class="r">{{amount|money}}</td><td></td><td></td></tr>
</table>
<p>Принято от <span class="u" style="min-width:380px">{{person}}</span></p>
<p>Основание <span class="u" style="min-width:390px">{{basis}}</span></p>
<p>Сумма <span class="u" style="min-width:380px">{{amountWords}}</span></p><div class="cap">прописью</div>
<p>Главный бухгалтер или уполномоченное лицо <span class="u">&nbsp;</span>/<span class="u">{{org.accountant}}</span></p><div class="cap">подпись &nbsp;&nbsp; расшифровка подписи</div>
<p>Получил кассир <span class="u">&nbsp;</span>/<span class="u">{{org.cashier}}</span></p><div class="cap">подпись &nbsp;&nbsp; расшифровка подписи</div>
</div>
<div style="border-left:1px dashed #000;writing-mode:vertical-rl;font-size:7pt;text-align:center;padding:0 2px">линия отреза &nbsp; М.П.</div>
<div style="flex:2">
<p>Организация (индивидуальный предприниматель) <span class="u">{{org.name}}</span></p>
<p class="c"><b>КВИТАНЦИЯ</b><br>к приходному кассовому ордеру № {{doc.number}}</p>
<p>Принято от <span class="u">{{person}}</span></p>
<p>Основание <span class="u">{{basis}}</span></p>
<p>Сумма <span class="u">{{amount|money}}</span> <span class="u">{{amountWords}}</span></p><div class="cap">прописью</div>
<p>МП "{{doc.date|date}}"</p>
<p>Главный бухгалтер или уполномоченное лицо <span class="u">&nbsp;</span>/<span class="u">{{org.accountant}}</span></p><div class="cap">подпись &nbsp;&nbsp; расшифровка подписи</div>
<p>Кассир <span class="u">&nbsp;</span>/<span class="u">{{org.cashier}}</span></p><div class="cap">подпись &nbsp;&nbsp; расшифровка подписи</div>
</div></div></div>`,
};

export const KO2: PrimaryForm = {
  name: 'Расходный кассовый ордер (КО-2)',
  source: 'Приказ МФ РК от 20.12.2012 № 562, приложение 2',
  html: `${CSS}<div class="p">${HEAD('КО-2')}
${NUMDATE}
<div class="t">РАСХОДНЫЙ КАССОВЫЙ ОРДЕР</div>
<table class="g">
<tr><th>Дебет</th><th rowspan="2">Кредит</th><th rowspan="2">Сумма, в тенге</th><th rowspan="2">Код целевого назначения</th></tr>
<tr><th>корреспондирующий счет</th></tr>
<tr><td class="c">{{entry.debit}}</td><td class="c">{{entry.credit}}</td><td class="r">{{amount|money}}</td><td></td></tr>
</table>
<p>Выдать <span class="u" style="min-width:420px">{{person}}</span></p><div class="cap">фамилия, имя, отчество</div>
<p>Основание <span class="u" style="min-width:410px">{{basis}}</span></p>
<p>Прилагаемые документы <span class="u" style="min-width:340px">{{attachment}}</span></p>
<p>Сумма <span class="u" style="min-width:400px">{{amountWords}}</span></p><div class="cap">прописью</div>
<p>Руководитель <span class="u">&nbsp;</span>/<span class="u">&nbsp;</span>/<span class="u">{{org.director}}</span></p><div class="cap">должность &nbsp;&nbsp; подпись &nbsp;&nbsp; расшифровка подписи</div>
<p>Главный бухгалтер или уполномоченное лицо <span class="u">&nbsp;</span>/<span class="u">{{org.accountant}}</span></p><div class="cap">подпись &nbsp;&nbsp; расшифровка подписи</div>
<p>Получил "___"________________20__года <span class="u">&nbsp;</span>/ <span class="u" style="min-width:220px">&nbsp;</span></p><div class="cap">подпись &nbsp;&nbsp; фамилия, имя, отчество</div>
<p>по <span class="u" style="min-width:440px">&nbsp;</span></p><div class="cap">наименование, номер, дата и место выдачи документа удостоверяющего личность получателя</div>
<p>Выдал кассир <span class="u">&nbsp;</span>/<span class="u">{{org.cashier}}</span></p><div class="cap">подпись &nbsp;&nbsp; расшифровка подписи</div>
</div>`,
};
