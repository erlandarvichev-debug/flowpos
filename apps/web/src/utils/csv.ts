/**
 * Выгрузка таблицы в CSV, который Excel открывает с кириллицей и колонками: UTF-8 с BOM, разделитель «;».
 * Числа — с запятой (русская локаль Excel), чтобы они считались числами, а не текстом.
 */
export type CsvCell = string | number | null | undefined

function cell(v: CsvCell): string {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v)
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) s = v.replace('.', ',')
  // защита от формул при открытии в Excel
  if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function downloadCsv(fileName: string, header: string[], rows: CsvCell[][]) {
  const text = '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  a.download = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
