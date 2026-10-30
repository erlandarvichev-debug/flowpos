// FP-008: поля оплаты труда видны только с правом payroll.read. Право на справочник сотрудников (hr.read)
// или на журнал аудита их не открывает (ТЗ: «Видимость поля зарплаты не следует из права на общий справочник сотрудников»).

/** Ключи с суммами оплаты и реквизитами выплаты. */
const PAY_KEY = /^(salary|hourlyRate|calculatedSalary|baseSalary|netAmount|netSalaryToPay|bonuses|deductions|taxes|amount|totalGrossSalary|baseAccrued|bonusAccrued|iban|bic)$/i;

export const PAY_HIDDEN = null;

/** Копия объекта (вглубь) без значений полей оплаты; сами ключи остаются со значением null. */
export function redactPay<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactPay(v)) as any;
  if (value && typeof value === 'object' && !(value instanceof Date) && value.constructor?.name !== 'Decimal') {
    const out: any = {};
    for (const [k, v] of Object.entries(value as any)) out[k] = PAY_KEY.test(k) ? PAY_HIDDEN : redactPay(v);
    return out;
  }
  return value;
}

/** Скрыть, если у роли нет payroll.read. */
export const payView = <T>(value: T, canSeePay: boolean): T => (canSeePay ? value : redactPay(value));
