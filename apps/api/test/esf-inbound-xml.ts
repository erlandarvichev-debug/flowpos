// FP-024: входящий ЭСФ InvoiceV2 для тестов (юнит и интеграционных); параметры подменяют фрагменты.
export function inboundXml(o: { num?: string; date?: string; turnoverDate?: string; type?: string | null; tin?: string; total?: string; related?: string; root?: string } = {}) {
  const root = o.root ?? 'v2:invoice';
  const type = o.type === null ? '' : `<invoiceType>${o.type ?? 'ORDINARY_INVOICE'}</invoiceType>`;
  return `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns:a="abstractInvoice.esf" xmlns:v2="v2.esf"><date>${o.date ?? '02.10.2026'}</date>${type}<num>${o.num ?? '77'}</num>${o.related ?? ''}<operatorFullname>X</operatorFullname><turnoverDate>${o.turnoverDate ?? '01.10.2026'}</turnoverDate><customers><customer><name>Мы</name><tin>123456789021</tin></customer></customers><productSet><currencyCode>KZT</currencyCode><products><product><description>Яблоки</description><ndsAmount>1600.00</ndsAmount><priceWithTax>11600.00</priceWithTax><priceWithoutTax>10000.00</priceWithoutTax><truOriginCode>4</truOriginCode></product></products><totalNdsAmount>1600.00</totalNdsAmount><totalPriceWithTax>${o.total ?? '11600.00'}</totalPriceWithTax><totalPriceWithoutTax>10000.00</totalPriceWithoutTax></productSet><sellers><seller><name>ТОО Поставщик</name><tin>${o.tin ?? '987654321098'}</tin></seller></sellers></${root}>`;
}

