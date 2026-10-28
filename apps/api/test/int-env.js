process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://flowpos:flowpos123@localhost:5432/flowpos_test?schema=public';
if (!/_test\b/.test(process.env.DATABASE_URL)) {
  throw new Error('Интеграционные тесты запускаются только на БД с суффиксом _test');
}
