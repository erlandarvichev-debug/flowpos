// Виды печатных форм и встроенные шаблоны. Формы с утверждённым бланком (З-2, Р-1, КО-1, КО-2) — по приказу МФ РК
// о формах первичных учётных документов (реквизиты сверены — см. source); счёт на оплату и акт сверки обязательной формы
// не имеют — по деловой практике РК.
import { Z2, R1, KO1, KO2 } from './templates-primary';

export type PrintKind = 'INVOICE' | 'Z2' | 'R1' | 'KO1' | 'KO2' | 'RECON';
export interface KindDef { kind: PrintKind; title: string; source: 'TRADE' | 'ACC' | 'RECON'; docTypes: string[]; lines?: 'GOODS' | 'SERVICES' | 'ALL' }
export interface BuiltinTemplate { id: string; kind: PrintKind; name: string; html: string; primary: boolean; source: string }

export const KINDS: KindDef[] = [
  { kind: 'INVOICE', title: 'Счёт на оплату', source: 'TRADE', docTypes: ['CUSTOMER_ORDER', 'DEMAND', 'INVOICE_OUT'], lines: 'ALL' },
  { kind: 'Z2', title: 'Накладная на отпуск запасов на сторону (З-2)', source: 'TRADE', docTypes: ['DEMAND', 'PURCHASE_RETURN'], lines: 'GOODS' },
  { kind: 'R1', title: 'Акт выполненных работ (оказанных услуг) (Р-1)', source: 'TRADE', docTypes: ['DEMAND'], lines: 'SERVICES' },
  { kind: 'KO1', title: 'Приходный кассовый ордер (КО-1)', source: 'ACC', docTypes: ['CASH_IN'] },
  { kind: 'KO2', title: 'Расходный кассовый ордер (КО-2)', source: 'ACC', docTypes: ['CASH_OUT'] },
  { kind: 'RECON', title: 'Акт сверки взаиморасчётов', source: 'RECON', docTypes: [] },
];

const CSS = `<style>
.f{font-size:10pt}.f h1{font-size:13pt;margin:6px 0}.f .r{text-align:right}.f .c{text-align:center}.f .muted{color:#555;font-size:8pt}
.f table.g{width:100%;border-collapse:collapse;margin:6px 0}.f table.g th,.f table.g td{border:1px solid #000;padding:3px 4px;font-size:9pt}
.f table.g th{background:#f2f2f2;font-weight:normal}.f .sig{margin-top:18px;display:flex;justify-content:space-between;gap:24px}
.f .line{display:inline-block;min-width:160px;border-bottom:1px solid #000}.f table.k td{padding:2px 6px;font-size:9pt}
</style>`;

const INVOICE = `${CSS}<div class="f">
<p class="muted">Внимание! Оплата данного счёта означает согласие с условиями поставки товара. Товар отпускается по факту прихода денег на р/с поставщика.</p>
<table class="g">
<tr><td colspan="2"><b>Бенефициар:</b><br>{{supplier.name}}<br>БИН: {{supplier.bin}}</td><td><b>ИИК</b><br>{{supplier.bank.iban}}</td><td><b>Кбе</b><br>{{org.kbe}}</td></tr>
<tr><td colspan="2"><b>Банк бенефициара:</b><br>{{supplier.bank.name}}</td><td><b>БИК</b><br>{{supplier.bank.bic}}</td><td><b>Код назначения платежа</b><br>710</td></tr>
</table>
<h1>Счёт на оплату № {{doc.number}} от {{doc.date|date}}</h1>
<table class="k">
<tr><td>Поставщик:</td><td><b>БИН / ИИН {{supplier.bin}}, {{supplier.name}}</b>{{#if supplier.address}}, {{supplier.address}}{{/if}}</td></tr>
<tr><td>Покупатель:</td><td><b>БИН / ИИН {{buyer.bin}}, {{buyer.name}}</b>{{#if buyer.address}}, {{buyer.address}}{{/if}}</td></tr>
<tr><td>Договор:</td><td>{{#if contract}}№ {{contract.number}} от {{contract.date|date}}{{else}}без договора{{/if}}</td></tr>
</table>
<table class="g">
<tr><th>№</th><th>Код</th><th>Наименование</th><th>Кол-во</th><th>Ед.</th><th>Цена</th><th>Сумма</th></tr>
{{#each lines}}<tr><td class="c">{{@n}}</td><td>{{code}}</td><td>{{name}}</td><td class="r">{{qty|qty}}</td><td>{{unit}}</td><td class="r">{{price|money}}</td><td class="r">{{amount|money}}</td></tr>{{/each}}
</table>
<p class="r"><b>Итого: {{totals.amount|money}}</b>{{#if vatPayer}}<br>В том числе НДС: {{totals.vat|money}}{{/if}}</p>
<p>Всего наименований {{totals.count}}, на сумму {{totals.amount|money}} KZT<br><b>Всего к оплате: {{amountWords}}</b></p>
<div class="sig"><div>Исполнитель <span class="line"></span> /{{org.director}}/</div></div>
</div>`;

const RECON = `${CSS}<div class="f">
<h1 class="c">Акт сверки взаимных расчётов</h1>
<p class="c">за период с {{period.from|date}} по {{period.to|date}}<br>между {{org.name}} (БИН {{org.bin}}) и {{counterparty.name}} (БИН {{counterparty.bin|default:—}}){{#if contract}}<br>по договору № {{contract.number}}{{/if}}</p>
<p>Мы, нижеподписавшиеся, составили настоящий акт сверки о том, что состояние взаимных расчётов по данным учёта следующее:</p>
<table class="g">
<tr><th colspan="4">По данным {{org.name}}, тенге</th><th colspan="4">По данным {{counterparty.name}}, тенге</th></tr>
<tr><th>Дата</th><th>Документ</th><th>Дебет</th><th>Кредит</th><th>Дата</th><th>Документ</th><th>Дебет</th><th>Кредит</th></tr>
<tr><td colspan="2"><b>Сальдо начальное</b></td><td class="r">{{openingDebit|money}}</td><td class="r">{{openingCredit|money}}</td><td colspan="2"><b>Сальдо начальное</b></td><td></td><td></td></tr>
{{#each lines}}<tr><td>{{date|date}}</td><td>{{document}}</td><td class="r">{{debit|money}}</td><td class="r">{{credit|money}}</td><td></td><td></td><td></td><td></td></tr>{{/each}}
<tr><td colspan="2"><b>Обороты за период</b></td><td class="r">{{turnover.debit|money}}</td><td class="r">{{turnover.credit|money}}</td><td colspan="2"><b>Обороты за период</b></td><td></td><td></td></tr>
<tr><td colspan="2"><b>Сальдо конечное</b></td><td class="r">{{closingDebit|money}}</td><td class="r">{{closingCredit|money}}</td><td colspan="2"><b>Сальдо конечное</b></td><td></td><td></td></tr>
</table>
<p>По данным {{org.name}} на {{period.to|date}} {{result}}.</p>
<div class="sig"><div>От {{org.name}}<br><br>Руководитель <span class="line"></span> /{{org.director}}/<br><br>Главный бухгалтер <span class="line"></span> /{{org.accountant}}/<br><br>М. П.</div>
<div>От {{counterparty.name}}<br><br>Руководитель <span class="line"></span><br><br>Главный бухгалтер <span class="line"></span><br><br>М. П.</div></div>
</div>`;

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { id: 'builtin:INVOICE', kind: 'INVOICE', name: 'Счёт на оплату (стандартный)', html: INVOICE, primary: true, source: 'Обязательной формы нет; реквизиты платежа по Правилам безналичных платежей НБРК (Кбе, КНП)' },
  { id: 'builtin:Z2', kind: 'Z2', name: Z2.name, html: Z2.html, primary: true, source: Z2.source },
  { id: 'builtin:R1', kind: 'R1', name: R1.name, html: R1.html, primary: true, source: R1.source },
  { id: 'builtin:KO1', kind: 'KO1', name: KO1.name, html: KO1.html, primary: true, source: KO1.source },
  { id: 'builtin:KO2', kind: 'KO2', name: KO2.name, html: KO2.html, primary: true, source: KO2.source },
  { id: 'builtin:RECON', kind: 'RECON', name: 'Акт сверки (стандартный)', html: RECON, primary: true, source: 'Обязательной формы нет; по деловой практике' },
];
