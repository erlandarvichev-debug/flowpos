# Официальные схемы ИС ЭСФ для тестов

- `invoice_v2.xsd`, `schema2.xsd` — получены 23.10.2026 вызовом `EsfXsdService.queryInvoiceXsd(version=InvoiceV2)`
  на тестовом стенде `https://test3.esf.kgd.gov.kz:8443/esf-web/ws/api1/EsfXsdService`. Не править вручную:
  при изменении схемы КГД — получить заново тем же вызовом.
