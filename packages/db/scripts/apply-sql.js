// Применяет SQL-инварианты из prisma/sql/*.sql по порядку (идемпотентно).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'prisma', 'sql');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  execFileSync('npx', ['prisma', 'db', 'execute', '--schema', 'prisma/schema.prisma', '--file', path.join(dir, f)], {
    cwd: root,
    stdio: 'inherit',
  });
  console.log('applied', f);
}
