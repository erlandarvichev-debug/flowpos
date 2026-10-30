// Применяет SQL из prisma/sql/*.sql по порядку (идемпотентно): инварианты и триггеры после `prisma db push`.
// С флагом --pre — prisma/sql/pre/*.sql ДО db push: подготовка существующих данных к новой схеме
// (expand: новые столбцы и их заполнение), чтобы db push смог поставить NOT NULL и ключи.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pre = process.argv.includes('--pre');
const dir = path.join(root, 'prisma', 'sql', ...(pre ? ['pre'] : []));
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  execFileSync('npx', ['prisma', 'db', 'execute', '--schema', 'prisma/schema.prisma', '--file', path.join(dir, f)], {
    cwd: root,
    stdio: 'inherit',
  });
  console.log('applied', pre ? `pre/${f}` : f);
}
