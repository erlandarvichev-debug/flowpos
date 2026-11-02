// FP-054: печатная форма декларации (PDF) и выгрузка в Excel. Шапка — как в разделе «Общая информация» бланка
// (приказ МФ № 695), строки — коды формы со значениями, затем контрольные соотношения и «Ответственность
// налогоплательщика». Черновик помечается водяным знаком; у готовой — хэш содержимого, у сданной — регистрационный номер.
import * as ExcelJS from 'exceljs';
import PDFDocument = require('pdfkit');
import { FORMS } from './forms';

const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

export interface DeclarationDoc {
  form: string; year: number; period: string; kind: string; status: string; contentHash: string; packVersion: string;
  header: any; lines: { code: string; name: string; value: string; formula?: string }[]; checks: { code: string; ok: boolean; severity: string; text: string; hint?: string }[];
  receipt: any; finalizedAt: Date | null; createdAt: Date;
}

const KIND: Record<string, string> = { INITIAL: 'первоначальная', ADDITIONAL: 'дополнительная', LIQUIDATION: 'ликвидационная', BY_NOTICE: 'по уведомлению' };
const STATUS: Record<string, string> = { DRAFT: 'черновик', FINAL: 'готова к сдаче', SUBMITTED: 'сдана', ACCEPTED: 'принята', REJECTED: 'отказ в приёме' };
const PERIOD: Record<string, string> = { Q1: '1 квартал', Q2: '2 квартал', Q3: '3 квартал', Q4: '4 квартал', H1: '1 полугодие', H2: '2 полугодие' };
const dmy = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.') : '');
const isPercent = (code: string) => /^300\.00\.00[78]$/.test(code) || code === '910.01 G';
const fmt = (code: string, v: string) => isPercent(code)
  ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(v))} %`
  : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));

export function headerRows(d: DeclarationDoc): [string, string][] {
  const h = d.header ?? {};
  const rows: [string, string][] = [
    ['ИИН (БИН)', h.bin ?? '—'],
    ['Наименование налогоплательщика', h.name ?? ''],
    ['Налоговый период', `${PERIOD[d.period] ?? d.period} ${d.year} года`],
    ['Вид декларации', KIND[d.kind] ?? d.kind],
    ['Код валюты', h.currency ?? 'KZT'],
  ];
  if (d.form === '300.00') rows.push(['Метод отнесения в зачёт', h.vatCreditMethod === 'PROPORTIONAL' ? 'пропорциональный' : String(h.vatCreditMethod ?? '')]);
  if (d.form === '910.00') {
    rows.push(['Организационно-правовая форма', h.legalForm === 'IP' ? 'индивидуальный предприниматель' : 'юридическое лицо']);
    if (h.rate) rows.push(['Ставка (910.01, графа G)', `${h.rate} %`]);
  }
  return rows;
}

export function declarationFileName(d: DeclarationDoc, ext: string) {
  return `${d.form.replace('.', '')}_${d.header?.bin ?? 'org'}_${d.year}${d.period}_${d.kind.toLowerCase()}.${ext}`;
}

export function declarationPdf(d: DeclarationDoc): Promise<Buffer> {
  const title = `Форма ${d.form}. ${FORMS[d.form]?.title ?? ''}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 }, info: { Title: title, Producer: 'FlowPOS' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('r', FONT);
    doc.registerFont('b', FONT_BOLD);
    const X = 40, W = doc.page.width - 80;
    const watermark = () => {
      if (d.status !== 'DRAFT') return;
      const { x, y } = doc; // водяной знак не должен сдвигать текст страницы
      doc.save().fillColor('#d32f2f').opacity(0.08).font('b').fontSize(90)
        .rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .text('ЧЕРНОВИК', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' }).restore();
      doc.opacity(1).fillColor('#000');
      doc.x = x; doc.y = y;
    };
    watermark();
    doc.on('pageAdded', watermark);

    doc.font('b').fontSize(13).text(title, X, 40, { width: W });
    doc.font('r').fontSize(8).fillColor('#555').text('Приказ МФ РК от 12.11.2025 № 695. Сформировано в FlowPOS — сверьте с бланком в кабинете налогоплательщика перед сдачей.', { width: W });
    doc.fillColor('#000').moveDown(0.6);

    doc.font('b').fontSize(9).text('Раздел «Общая информация о налогоплательщике»', { width: W }).moveDown(0.2);
    for (const [k, v] of headerRows(d)) {
      const y = doc.y;
      doc.font('r').fontSize(8.5).text(k, X, y, { width: 190 });
      doc.font('b').text(v, X + 195, y, { width: W - 195 });
      doc.y = Math.max(doc.y, y + 12);
    }
    doc.moveDown(0.6);

    const cCode = 110, cVal = 110, cName = W - cCode - cVal;
    const row = (cells: [string, string, string], opts: { bold?: boolean; fill?: string; sub?: string } = {}) => {
      doc.font(opts.bold ? 'b' : 'r').fontSize(8);
      const h = Math.max(doc.heightOfString(cells[1], { width: cName - 8 }) + (opts.sub ? doc.font('r').fontSize(6.5).heightOfString(opts.sub, { width: cName - 8 }) : 0), 10) + 6;
      if (doc.y + h > doc.page.height - 50) doc.addPage();
      const y = doc.y;
      if (opts.fill) doc.save().rect(X, y, W, h).fill(opts.fill).restore();
      doc.fillColor('#000').font(opts.bold ? 'b' : 'r').fontSize(8);
      doc.text(cells[0], X + 3, y + 3, { width: cCode - 6 });
      doc.text(cells[1], X + cCode, y + 3, { width: cName - 8 });
      if (opts.sub) doc.font('r').fontSize(6.5).fillColor('#777').text(opts.sub, X + cCode, doc.y, { width: cName - 8 }).fillColor('#000');
      doc.font(opts.bold ? 'b' : 'r').fontSize(8).text(cells[2], X + cCode + cName, y + 3, { width: cVal - 4, align: 'right' });
      doc.moveTo(X, y + h).lineTo(X + W, y + h).lineWidth(0.3).strokeColor('#cccccc').stroke();
      doc.y = y + h;
    };
    row(['Код строки', 'Наименование показателя', 'Сумма'], { bold: true, fill: '#eef2f7' });
    for (const l of d.lines) row([l.code, l.name, fmt(l.code, l.value)], { bold: !/ [IV]+ \d/.test(l.code) && !l.code.startsWith('910.01'), sub: l.formula });

    doc.moveDown(0.8).font('b').fontSize(8.5).text('Контрольные соотношения', X, doc.y, { width: W });
    doc.font('r').fontSize(7.5);
    for (const c of d.checks) doc.fillColor(c.ok ? '#2e7d32' : c.severity === 'ERROR' ? '#c62828' : '#b26a00').text(`${c.ok ? '✓' : '✗'} ${c.text}${!c.ok && c.hint ? ` — ${c.hint}` : ''}`, X, doc.y, { width: W });
    doc.fillColor('#000').moveDown(0.8);

    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.font('b').fontSize(9).text('Раздел «Ответственность налогоплательщика»', X, doc.y, { width: W }).moveDown(0.3);
    doc.font('r').fontSize(8.5)
      .text('Мы несём ответственность за достоверность и полноту сведений, приведённых в настоящей декларации.', { width: W })
      .moveDown(0.6)
      .text('Ф. И. О. руководителя (налогоплательщика) ________________________________   Подпись ____________', { width: W })
      .moveDown(0.6)
      .text(`Дата подачи декларации ________________     Код органа государственных доходов ________`, { width: W });
    if (d.receipt?.number) doc.moveDown(0.4).font('b').text(`Регистрационный номер: ${d.receipt.number} от ${dmy(d.receipt.date)}`, { width: W });

    doc.moveDown(1).font('r').fontSize(6.5).fillColor('#888')
      .text(`Статус: ${STATUS[d.status] ?? d.status}${d.finalizedAt ? ` (${dmy(d.finalizedAt)})` : ''}. Пакет правил ${d.packVersion}. Контрольная сумма содержимого: ${d.contentHash}`, { width: W });
    doc.end();
  });
}

export async function declarationXlsx(d: DeclarationDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FlowPOS';
  const ws = wb.addWorksheet(d.form, { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 20 }, { width: 70 }, { width: 20 }];
  ws.addRow([`Форма ${d.form}. ${FORMS[d.form]?.title ?? ''}`]).font = { bold: true, size: 13 };
  ws.addRow([`Статус: ${STATUS[d.status] ?? d.status}${d.status === 'DRAFT' ? ' — ЧЕРНОВИК' : ''}`]).font = { italic: true, color: { argb: d.status === 'DRAFT' ? 'FFC62828' : 'FF666666' } };
  for (const [k, v] of headerRows(d)) ws.addRow([k, v]);
  ws.addRow([]);
  const head = ws.addRow(['Код строки', 'Наименование показателя', 'Сумма']);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } }; });
  for (const l of d.lines) {
    const r = ws.addRow([l.code, l.formula ? `${l.name} (${l.formula})` : l.name, Number(l.value)]);
    r.getCell(3).numFmt = isPercent(l.code) ? '0.00"%"' : '#,##0.00';
  }
  ws.addRow([]);
  ws.addRow(['Контрольные соотношения']).font = { bold: true };
  for (const c of d.checks) ws.addRow([c.ok ? '✓' : '✗', c.text]).font = { color: { argb: c.ok ? 'FF2E7D32' : 'FFC62828' } };
  if (d.receipt?.number) ws.addRow(['Рег. номер', `${d.receipt.number} от ${dmy(d.receipt.date)}`]);
  ws.addRow(['Контрольная сумма', d.contentHash]).font = { size: 8, color: { argb: 'FF888888' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
