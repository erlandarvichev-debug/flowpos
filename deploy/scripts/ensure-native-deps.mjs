#!/usr/bin/env node
// Докачивает платформенные сборки опциональных зависимостей, которых нет в package-lock.json.
// Зачем: lock-файл сделан на macOS и содержит, например, только @rollup/rollup-darwin-arm64 — на Linux `npm ci`
// не ставит @rollup/rollup-linux-x64-gnu, и сборка веба падает (известная ошибка npm, npm/cli#4828). Перестраивать
// весь lock ради этого рискованно (меняются сотни версий), поэтому здесь — точечно: версия ровно из lock-файла
// (optionalDependencies пакета-родителя), скачивание через `npm pack` (проверка целостности npm), распаковка туда,
// где родитель её ищет. Уже установленные — пропускаются. Запуск из корня релиза после `npm ci`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages ?? {};
const PLATFORMS = ['darwin', 'linux', 'win32', 'freebsd', 'android', 'openbsd', 'sunos', 'netbsd', 'aix', 'openharmony'];
const platform = process.platform;
const arch = process.arch;
const musl = platform === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime;

/** Сборка для этой ОС и процессора: «…linux-x64…», для Linux — glibc (не musl), если не musl-система. */
function pick(names) {
  const exact = names.filter((n) => new RegExp(`(^|[-/])${platform}-${arch}($|-)`).test(n));
  return exact.find((n) => (musl ? n.includes('musl') : !n.includes('musl'))) ?? exact[0] ?? null;
}

let installed = 0;
for (const [path, meta] of Object.entries(lock)) {
  const opt = meta?.optionalDependencies;
  if (!path || !opt) continue;
  const native = Object.keys(opt).filter((n) => PLATFORMS.some((p) => n.includes(p)));
  if (native.length < 2) continue; // не платформенный набор
  const name = pick(native);
  if (!name) continue;
  const root = path.slice(0, path.lastIndexOf('node_modules/') + 'node_modules'.length); // где родитель ищет зависимость
  const target = join(root, name);
  if (existsSync(join(target, 'package.json'))) continue;
  const version = opt[name];
  const tmp = mkdtempSync(join(tmpdir(), 'native-'));
  try {
    const file = execFileSync('npm', ['pack', `${name}@${version}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
    mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', join(tmp, file), '-C', target, '--strip-components=1']);
    console.log(`   + ${name}@${version} → ${target} (для ${path.replace(/^.*node_modules\//, '')})`);
    installed++;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(installed ? `   платформенных сборок докачано: ${installed}` : '   все платформенные сборки на месте');
