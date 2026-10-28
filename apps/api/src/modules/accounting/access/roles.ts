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
  'hr.read', 'hr.manage', 'payroll.approve',
  'org.members.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'owner', 'admin', 'chief_accountant', 'accountant', 'hr', 'cashier', 'storekeeper', 'manager', 'auditor',
] as const;
export type OrgRole = (typeof ROLES)[number];

const READ_ALL: Permission[] = ['acc.chart.read', 'acc.doc.read', 'acc.reports.read', 'acc.refs.read', 'acc.esf.read'];

export const ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter((p) => p !== 'acc.period.override'),
  chief_accountant: PERMISSIONS.filter((p) => p !== 'org.members.manage'),
  accountant: [...READ_ALL, 'acc.doc.write', 'acc.doc.post', 'acc.doc.cancel', 'acc.refs.manage', 'acc.esf.send', 'hr.read', 'hr.manage', 'payroll.approve'],
  hr: ['acc.refs.read', 'hr.read', 'hr.manage'],
  cashier: ['acc.doc.read', 'acc.doc.write', 'acc.refs.read'],
  storekeeper: ['acc.doc.read', 'acc.refs.read'],
  manager: [...READ_ALL, 'hr.read'],
  auditor: [...READ_ALL, 'acc.audit.read'],
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
