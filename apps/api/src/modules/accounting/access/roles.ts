// Матрица ролей и прав бухгалтерского контура. Права проверяются на сервере для каждого запроса.

export const PERMISSIONS = [
  'acc.chart.read', 'acc.chart.manage',
  'acc.doc.read', 'acc.doc.write', 'acc.doc.post', 'acc.doc.cancel',
  'acc.period.lock', 'acc.period.override',
  'acc.reports.read',
  'acc.refs.read', 'acc.refs.manage',
  'acc.policy.manage',
  'acc.audit.read',
  'acc.esf.read', 'acc.esf.send',
  'acc.tax.manage', // FP-019: распределение входного НДС (к зачёту / не к зачёту, сторно)
  'acc.esf.approve', // FP-018: утверждение решений по ЭСФ (отзыв, отклонение, подтверждение, основание)
  'hr.read', 'hr.manage', 'payroll.approve',
  'org.members.manage',
  // FP-008: старые модули и обмен
  'payroll.read', // поля зарплаты; не следует из права на справочник сотрудников (hr.read)
  'catalog.read', 'catalog.manage',
  'stock.read',
  'trade.read', 'trade.write',
  'pos.operate', 'pos.manage',
  'analytics.read',
  'sync.read', 'sync.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'owner', 'admin', 'chief_accountant', 'accountant', 'hr', 'cashier', 'storekeeper', 'manager', 'auditor',
] as const;
export type OrgRole = (typeof ROLES)[number];

const READ_ALL: Permission[] = ['acc.chart.read', 'acc.doc.read', 'acc.reports.read', 'acc.refs.read', 'acc.esf.read'];
const TRADE_READ: Permission[] = ['catalog.read', 'stock.read', 'trade.read'];

export const ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter((p) => p !== 'acc.period.override'),
  chief_accountant: PERMISSIONS.filter((p) => p !== 'org.members.manage'),
  accountant: [...READ_ALL, 'acc.doc.write', 'acc.doc.post', 'acc.doc.cancel', 'acc.refs.manage', 'acc.esf.send', 'hr.read', 'hr.manage', 'payroll.approve', 'payroll.read', ...TRADE_READ, 'catalog.manage', 'trade.write', 'analytics.read', 'sync.read'],
  // Кадровик ведёт кадры, но зарплату видит только с payroll.read — его у роли нет.
  hr: ['acc.refs.read', 'hr.read', 'hr.manage'],
  cashier: ['acc.doc.read', 'acc.doc.write', 'acc.refs.read', 'catalog.read', 'stock.read', 'pos.operate'],
  storekeeper: ['acc.doc.read', 'acc.refs.read', ...TRADE_READ, 'trade.write'],
  manager: [...READ_ALL, 'hr.read', ...TRADE_READ, 'analytics.read', 'sync.read'],
  auditor: [...READ_ALL, 'acc.audit.read', ...TRADE_READ, 'analytics.read', 'sync.read'],
};

export const ROLE_LABELS: Record<OrgRole, { ru: string; kk: string }> = {
  owner: { ru: 'Владелец', kk: 'Иесі' },
  admin: { ru: 'Администратор', kk: 'Әкімші' },
  chief_accountant: { ru: 'Главный бухгалтер', kk: 'Бас бухгалтер' },
  accountant: { ru: 'Бухгалтер', kk: 'Бухгалтер' },
  hr: { ru: 'Кадровик', kk: 'Кадр маманы' },
  cashier: { ru: 'Кассир', kk: 'Кассир' },
  storekeeper: { ru: 'Кладовщик', kk: 'Қойма меңгерушісі' },
  manager: { ru: 'Руководитель', kk: 'Басшы' },
  auditor: { ru: 'Аудитор', kk: 'Аудитор' },
};

export function hasPermission(role: string, perm: Permission): boolean {
  return (ROLE_PERMISSIONS[role as OrgRole] || []).includes(perm);
}

/**
 * Назначить (или изменить) роль можно, только если все её права есть у назначающего: администратор не сделает
 * владельца и не понизит его, бухгалтер не выдаст себе или другим права администратора (FP-008).
 */
export function canGrant(granterRole: string, role: string): boolean {
  const mine = ROLE_PERMISSIONS[granterRole as OrgRole];
  const target = ROLE_PERMISSIONS[role as OrgRole];
  return !!mine && !!target && target.every((p) => mine.includes(p));
}

/** Роль старого модуля прав (user_roles) → роль в организации. Права даёт только роль в организации. */
export const LEGACY_ROLE_TO_ORG_ROLE: Record<string, OrgRole> = { admin: 'admin', manager: 'manager', cashier: 'cashier', hr: 'hr' };

