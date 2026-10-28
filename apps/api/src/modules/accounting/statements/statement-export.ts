// Выгрузка форм финансовой отчётности в XLSX и PDF (шапка как в форме: организация, БИН, период, единицы).
import * as ExcelJS from 'exceljs';
import PDFDocument = require('pdfkit'); // CommonJS-модуль: без esModuleInterop только так
import { Statement } from './statements.service';

const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const dmy = (s?: string) => (s ? s.split('-').reverse().join('.') : '');
const unitLabel = (st: Statement) => (st.unit === 'THOUSANDS' ? 'в тысячах тенге' : 'в тенге');
function columns(st: Statement): [string, string] {
  if (st.form === 'BALANCE') return [`На ${dmy(st.period.to)}`, `На ${dmy(st.period.previousTo)}`];
  return [`За ${dmy(st.period.from)}–${dmy(st.period.to)}`, `За ${dmy(st.period.previousFrom)}–${dmy(st.period.previousTo)}`];
}
const num = (v: string | null) => (v === null ? null : Number(v));

export function fileName(st: Statement, ext: string) {
  const base = { BALANCE: 'balans', PL: 'opu', CASHFLOW: 'dds' }[st.form];
  return `${base}_${st.organization.bin ?? 'org'}_${st.period.to}.${ext}`;
}

export async function toXlsx(st: Statement): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FlowPOS';
  const ws = wb.addWorksheet(st.form === 'BALANCE' ? 'Баланс' : st.form === 'PL' ? 'ОПиУ' : 'ДДС', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 70 }, { width: 10 }, { width: 20 }, { width: 20 }];
  const fmt = st.unit === 'TENGE' ? '#,##0.00;[Red]-#,##0.00' : '#,##0;[Red]-#,##0';
  ws.addRow([st.title]).font = { bold: true, size: 13 };
  ws.addRow([`${st.organization.name}${st.organization.bin ? `, БИН ${st.organization.bin}` : ''}`]);
  ws.addRow([st.form === 'BALANCE' ? `по состоянию на ${dmy(st.period.to)}` : `за период ${dmy(st.period.from)} – ${dmy(st.period.to)}`]);
  ws.addRow([unitLabel(st)]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  const [c1, c2] = columns(st);
  const head = ws.addRow(['Наименование показателей', 'Код строки', c1, c2]);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } }; c.border = { bottom: { style: 'thin' } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
  for (const l of st.lines) {
    const r = ws.addRow([`${'   '.repeat(l.indent ?? 0)}${l.name}`, l.header || /^[A-Z]/.test(l.code) ? '' : l.code, num(l.current), num(l.previous)]);
    r.getCell(1).alignment = { wrapText: true };
    r.getCell(2).alignment = { horizontal: 'center' };
    r.getCell(3).numFmt = fmt; r.getCell(4).numFmt = fmt;
    if (l.bold || l.header) r.font = { bold: true };
  }
  ws.addRow([]);
  for (const c of st.checks) ws.addRow([`${c.ok ? '✓' : '✗'} ${c.message}`]).font = { color: { argb: c.ok ? 'FF2E7D32' : 'FFC62828' }, size: 9 };
  ws.addRow([`Форма: ${st.source}`]).font = { size: 8, color: { argb: 'FF888888' } };
  ws.addRow([st.note]).font = { size: 8, color: { argb: 'FF888888' } };
  ws.addRow([]);
  ws.addRow(['Руководитель ______________________        Главный бухгалтер ______________________']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(st: Statement): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 }, info: { Title: st.title, Producer: 'FlowPOS' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('r', FONT);
    doc.registerFont('b', FONT_BOLD);
    const W = doc.page.width - 80, X = 40;
    const col = { name: W - 60 - 2 * 100, code: 60, a: 100, b: 100 };
    const money = (v: string | null) => (v === null ? '' : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: st.unit === 'TENGE' ? 2 : 0, maximumFractionDigits: st.unit === 'TENGE' ? 2 : 0 }).format(Number(v)));

    doc.font('b').fontSize(12).text(st.title, X, doc.y, { width: W });
    doc.font('r').fontSize(9).text(`${st.organization.name}${st.organization.bin ? `, БИН ${st.organization.bin}` : ''}`, { width: W });
    doc.text(st.form === 'BALANCE' ? `по состоянию на ${dmy(st.period.to)}, ${unitLabel(st)}` : `за период ${dmy(st.period.from)} – ${dmy(st.period.to)}, ${unitLabel(st)}`, { width: W });
    doc.moveDown(0.6);

    const [c1, c2] = columns(st);
    const row = (cells: [string, string, string, string], bold = false, fill?: string) => {
      doc.font(bold ? 'b' : 'r').fontSize(8);
      const h = Math.max(doc.heightOfString(cells[0], { width: col.name - 6 }), 10) + 6;
      if (doc.y + h > doc.page.height - 50) doc.addPage();
      const y = doc.y;
      if (fill) doc.save().rect(X, y, W, h).fill(fill).restore();
      doc.fillColor('#000');
      doc.text(cells[0], X + 3, y + 3, { width: col.name - 6 });
      doc.text(cells[1], X + col.name, y + 3, { width: col.code, align: 'center' });
      doc.text(cells[2], X + col.name + col.code, y + 3, { width: col.a - 4, align: 'right' });
      doc.text(cells[3], X + col.name + col.code + col.a, y + 3, { width: col.b - 4, align: 'right' });
      doc.moveTo(X, y + h).lineTo(X + W, y + h).lineWidth(0.3).strokeColor('#cccccc').stroke();
      doc.y = y + h;
    };
    row(['Наименование показателей', 'Код', c1, c2], true, '#eef2f7');
    for (const l of st.lines) row([`${'   '.repeat(l.indent ?? 0)}${l.name}`, l.header || /^[A-Z]/.test(l.code) ? '' : l.code, money(l.current), money(l.previous)], !!(l.bold || l.header));

    doc.moveDown(0.8).font('r').fontSize(7.5);
    for (const c of st.checks) doc.fillColor(c.ok ? '#2e7d32' : '#c62828').text(`${c.ok ? '✓' : '✗'} ${c.message}`, X, doc.y, { width: W });
    doc.fillColor('#777').text(`Форма: ${st.source}. ${st.note}`, X, doc.y + 4, { width: W });
    doc.fillColor('#000').fontSize(9).text('Руководитель ______________________          Главный бухгалтер ______________________', X, doc.y + 18, { width: W });
    doc.end();
  });
}

/** ОСВ в XLSX: счета с разделами, сальдо и обороты Дт/Кт, итоги. */
export async function trialBalanceXlsx(tb: any, org: { name: string; bin: string | null }, period: { from: string; to: string }, ledger: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ОСВ', { views: [{ state: 'frozen', ySplit: 6 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 12 }, { width: 55 }, ...Array(6).fill({ width: 17 })];
  ws.addRow([`Оборотно-сальдовая ведомость (${ledger === 'NU' ? 'налоговый учёт' : 'бухгалтерский учёт'})`]).font = { bold: true, size: 13 };
  ws.addRow([`${org.name}${org.bin ? `, БИН ${org.bin}` : ''}`]);
  ws.addRow([`за период ${dmy(period.from)} – ${dmy(period.to)}, в тенге`]);
  ws.addRow([]);
  const h1 = ws.addRow(['Счёт', 'Наименование', 'Сальдо на начало', '', 'Обороты за период', '', 'Сальдо на конец', '']);
  const h2 = ws.addRow(['', '', 'Дебет', 'Кредит', 'Дебет', 'Кредит', 'Дебет', 'Кредит']);
  ws.mergeCells('C5:D5'); ws.mergeCells('E5:F5'); ws.mergeCells('G5:H5');
  for (const h of [h1, h2]) { h.font = { bold: true }; h.eachCell((c) => { c.alignment = { horizontal: 'center' }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } }; }); }
  const n = (v: string) => (Number(v) ? Number(v) : null);
  for (const l of tb.lines as any[]) {
    const r = ws.addRow([l.code, l.name, n(l.opening.debit), n(l.opening.credit), n(l.turnover.debit), n(l.turnover.credit), n(l.closing.debit), n(l.closing.credit)]);
    for (let i = 3; i <= 8; i++) r.getCell(i).numFmt = '#,##0.00';
    if (l.isGroup) r.font = { bold: true };
  }
  const t = tb.totals;
  if (t) {
    const r = ws.addRow(['', 'Итого', n(t.opening.debit), n(t.opening.credit), n(t.turnover.debit), n(t.turnover.credit), n(t.closing.debit), n(t.closing.credit)]);
    r.font = { bold: true };
    for (let i = 3; i <= 8; i++) r.getCell(i).numFmt = '#,##0.00';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
