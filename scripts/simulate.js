#!/usr/bin/env node
/**
 * FlowPOS API Simulator — проверяет все основные эндпоинты
 */

const BASE = 'http://localhost:3000/api/v1';
let token = '';
let passed = 0;
let failed = 0;

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';

const log = (m) => process.stdout.write(m + '\n');
const ok = (l) => { passed++; log(`  ${G}✓${X} ${l}`); };
const fail = (l, e) => { failed++; log(`  ${R}✗${X} ${l}: ${R}${e}${X}`); };
const section = (n) => log(`\n${B}${C}── ${n} ──${X}`);

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data };
}

async function check(label, fn) {
  try { await fn(); ok(label); } catch (e) { fail(label, e.message); }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

let productId, storeId, counterpartyId, employeeId, terminalId, shiftId;

async function main() {
  log(`\n${B}FlowPOS API Simulator${X}  →  ${BASE}\n`);

  // ─── AUTH ───────────────────────────────────────────────────────────────────
  section('AUTH');

  await check('POST /auth/login — неверный пароль → 4xx', async () => {
    const r = await api('POST', '/auth/login', { email: 'admin@flowpos.kz', password: 'wrong' });
    assert(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  });

  await check('POST /auth/login — admin@flowpos.kz / admin123', async () => {
    const r = await api('POST', '/auth/login', { email: 'admin@flowpos.kz', password: 'admin123' });
    assert([200, 201].includes(r.status), `expected 200/201, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data.accessToken, 'no accessToken');
    token = r.data.accessToken;
  });

  await check('GET /auth/me — профиль текущего пользователя', async () => {
    const r = await api('GET', '/auth/me');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.data.email === 'admin@flowpos.kz', `wrong email: ${r.data.email}`);
  });

  // ─── CATALOG: ITEMS ─────────────────────────────────────────────────────────
  section('CATALOG / ITEMS');

  await check('GET /catalog/items — список товаров', async () => {
    const r = await api('GET', '/catalog/items');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const items = r.data.items || r.data;
    assert(Array.isArray(items), 'expected array');
    if (items.length > 0) productId = items[0].id;
  });

  await check('GET /catalog/items/groups — группы товаров', async () => {
    const r = await api('GET', '/catalog/items/groups');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /catalog/items/units — единицы измерения', async () => {
    const r = await api('GET', '/catalog/items/units');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('POST /catalog/items — создать товар', async () => {
    const r = await api('POST', '/catalog/items', {
      name: `Тест Симулятор ${Date.now()}`,
      code: `SIM-${Date.now()}`,
      uomId: 'uom-pcs',
    });
    assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    productId = r.data.id || productId;
  });

  await check('GET /catalog/items?search=Тест — поиск', async () => {
    const r = await api('GET', '/catalog/items?search=Тест');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  if (productId) {
    await check(`GET /catalog/items/:id — карточка товара`, async () => {
      const r = await api('GET', `/catalog/items/${productId}`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });
  }

  // ─── CATALOG: WAREHOUSES ────────────────────────────────────────────────────
  section('CATALOG / WAREHOUSES');

  await check('GET /catalog/warehouses — список складов', async () => {
    const r = await api('GET', '/catalog/warehouses');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const stores = r.data.stores || r.data.items || r.data;
    if (Array.isArray(stores) && stores.length > 0) storeId = stores[0].id;
  });

  if (storeId) {
    await check('GET /catalog/warehouses/:id — карточка склада', async () => {
      const r = await api('GET', `/catalog/warehouses/${storeId}`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });

    await check('GET /catalog/warehouses/:id/stocks — остатки склада', async () => {
      const r = await api('GET', `/catalog/warehouses/${storeId}/stocks`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });
  }

  // ─── CATALOG: COUNTERPARTIES ────────────────────────────────────────────────
  section('CATALOG / COUNTERPARTIES');

  await check('GET /catalog/counterparties — список контрагентов', async () => {
    const r = await api('GET', '/catalog/counterparties');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const cps = r.data.counterparties || r.data;
    if (Array.isArray(cps) && cps.length > 0) counterpartyId = cps[0].id;
  });

  await check('GET /catalog/counterparties/groups — группы контрагентов', async () => {
    const r = await api('GET', '/catalog/counterparties/groups');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('POST /catalog/counterparties — создать контрагента', async () => {
    const r = await api('POST', '/catalog/counterparties', {
      name: `ТОО "Тест Симулятор ${Date.now()}"`,
      type: 'SUPPLIER',
    });
    assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    counterpartyId = r.data.id || counterpartyId;
  });

  if (counterpartyId) {
    await check('GET /catalog/counterparties/:id — карточка контрагента', async () => {
      const r = await api('GET', `/catalog/counterparties/${counterpartyId}`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });
  }

  // ─── TRADE: PURCHASES ───────────────────────────────────────────────────────
  section('TRADE / ЗАКУПКИ');

  await check('GET /trade/purchase-orders — заказы поставщику', async () => {
    const r = await api('GET', '/trade/purchase-orders');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  if (counterpartyId && productId && storeId) {
    await check('POST /trade/purchase-orders — создать заказ поставщику', async () => {
      const r = await api('POST', '/trade/purchase-orders', {
        counterpartyId,
        storeId,
        date: new Date().toISOString().substring(0, 10),
        items: [{ productId, qty: 10, price: 500 }],
      });
      assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    });
  }

  await check('GET /trade/goods-receipts — приходные накладные', async () => {
    const r = await api('GET', '/trade/goods-receipts');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ─── TRADE: SALES ───────────────────────────────────────────────────────────
  section('TRADE / ПРОДАЖИ');

  await check('GET /trade/sales-orders — заказы покупателей', async () => {
    const r = await api('GET', '/trade/sales-orders');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  if (counterpartyId && productId) {
    await check('POST /trade/sales-orders — создать заказ покупателя', async () => {
      const r = await api('POST', '/trade/sales-orders', {
        counterpartyId,
        date: new Date().toISOString().substring(0, 10),
        items: [{ productId, qty: 2, price: 890 }],
      });
      assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    });
  }

  await check('GET /trade/shipments — расходные накладные', async () => {
    const r = await api('GET', '/trade/shipments');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ─── TRADE: STOCK OPS ───────────────────────────────────────────────────────
  section('TRADE / СКЛАД');

  await check('GET /trade/stocks — остатки на складах', async () => {
    const r = await api('GET', '/trade/stocks');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /trade/transfers — перемещения', async () => {
    const r = await api('GET', '/trade/transfers');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /trade/inventories — инвентаризации', async () => {
    const r = await api('GET', '/trade/inventories');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ─── POS ────────────────────────────────────────────────────────────────────
  section('POS / КАССА');

  await check('GET /pos/terminals — список касс', async () => {
    const r = await api('GET', '/pos/terminals');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    if (Array.isArray(r.data) && r.data.length > 0) terminalId = r.data[0].id;
  });

  if (terminalId) {
    await check('GET /pos/terminals/:id/active-shift — активная смена', async () => {
      const r = await api('GET', `/pos/terminals/${terminalId}/active-shift`);
      assert([200, 404].includes(r.status), `unexpected ${r.status}`);
    });

    await check('POST /pos/terminals/:id/open-shift — открыть смену', async () => {
      const r = await api('POST', `/pos/terminals/${terminalId}/open-shift`, { openBalance: 50000 });
      if ([200, 201].includes(r.status)) {
        shiftId = r.data.id;
      } else if (r.status === 400 && r.data.message?.includes('уже открыта')) {
        // смена уже открыта — ок
      } else {
        throw new Error(`unexpected ${r.status}: ${JSON.stringify(r.data)}`);
      }
    });

    // Если смена не открылась, найдём существующую
    if (!shiftId) {
      const existing = await api('GET', '/pos/shifts?status=OPEN');
      shiftId = existing.data?.shifts?.[0]?.id;
    }
  }

  await check('GET /pos/shifts — список смен', async () => {
    const r = await api('GET', '/pos/shifts');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    if (!shiftId && r.data?.shifts?.length > 0) shiftId = r.data.shifts[0].id;
  });

  if (shiftId) {
    await check('POST /pos/shifts/:id/cash-in — внесение наличных', async () => {
      const r = await api('POST', `/pos/shifts/${shiftId}/cash-in`, { amount: 10000, comment: 'Начало дня' });
      assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    });

    await check('GET /pos/receipts — список чеков', async () => {
      const r = await api('GET', '/pos/receipts');
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });

    if (productId) {
      await check('POST /pos/receipts — создать чек (розничная продажа)', async () => {
        const r = await api('POST', '/pos/receipts', {
          storeId: storeId || 'store-retail',
          items: [{ productId, qty: 1, price: 890 }],
        });
        assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
      });
    }

    await check('POST /pos/shifts/:id/cash-out — изъятие наличных', async () => {
      const r = await api('POST', `/pos/shifts/${shiftId}/cash-out`, { amount: 5000, comment: 'Инкассация' });
      assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    });
  }

  // ─── HR ─────────────────────────────────────────────────────────────────────
  section('HR / ПЕРСОНАЛ');

  await check('GET /hr/employees — сотрудники', async () => {
    const r = await api('GET', '/hr/employees');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const emps = r.data.employees || r.data;
    if (Array.isArray(emps) && emps.length > 0) employeeId = emps[0].id;
  });

  await check('POST /hr/employees — создать сотрудника', async () => {
    const r = await api('POST', '/hr/employees', { firstName: 'Симулятор', lastName: 'Тест', isActive: true });
    assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    employeeId = r.data.id || employeeId;
  });

  if (employeeId) {
    await check('GET /hr/employees/:id — карточка сотрудника', async () => {
      const r = await api('GET', `/hr/employees/${employeeId}`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });

    await check('POST /hr/employees/:id/check-in — отметка прихода', async () => {
      const r = await api('POST', `/hr/employees/${employeeId}/check-in`);
      assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    });

    await check('POST /hr/employees/:id/check-out — отметка ухода', async () => {
      const r = await api('POST', `/hr/employees/${employeeId}/check-out`);
      assert([200, 201].includes(r.status), `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    });

    await check('GET /hr/employees/:id/time-records — табель сотрудника', async () => {
      const r = await api('GET', `/hr/employees/${employeeId}/time-records`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });
  }

  await check('GET /hr/shift-templates — шаблоны смен', async () => {
    const r = await api('GET', '/hr/shift-templates');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  const now = new Date();
  await check('GET /hr/schedule — расписание', async () => {
    const from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const to = now.toISOString().substring(0, 10);
    const r = await api('GET', `/hr/schedule?from=${from}&to=${to}`);
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /hr/timesheet — табель текущего месяца', async () => {
    const r = await api('GET', `/hr/timesheet?month=${now.getMonth()+1}&year=${now.getFullYear()}`);
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /hr/payrolls — зарплатные ведомости', async () => {
    const r = await api('GET', '/hr/payrolls');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ─── ANALYTICS ──────────────────────────────────────────────────────────────
  section('ANALYTICS / АНАЛИТИКА');

  const from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const to = now.toISOString().substring(0, 10);

  await check('GET /analytics/dashboard — дашборд', async () => {
    const r = await api('GET', `/analytics/dashboard?from=${from}&to=${to}`);
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.data.kpi, `no kpi: ${JSON.stringify(r.data)}`);
  });

  await check('GET /analytics/stocks — остатки', async () => {
    const r = await api('GET', '/analytics/stocks');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /analytics/sales-turnover — оборот продаж', async () => {
    const r = await api('GET', `/analytics/sales-turnover?from=${from}&to=${to}`);
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /analytics/hr-dashboard — HR дашборд', async () => {
    const r = await api('GET', `/analytics/hr-dashboard?from=${from}&to=${to}`);
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ─── SYNC ───────────────────────────────────────────────────────────────────
  section('SYNC / СИНХРОНИЗАЦИЯ');

  await check('GET /sync/status — статус очереди', async () => {
    const r = await api('GET', '/sync/status');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(typeof r.data.pending === 'number', `no pending: ${JSON.stringify(r.data)}`);
  });

  await check('GET /sync/queue — записи очереди', async () => {
    const r = await api('GET', '/sync/queue');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /sync/outbox — outbox', async () => {
    const r = await api('GET', '/sync/outbox');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /sync/outbox/status — статус outbox', async () => {
    const r = await api('GET', '/sync/outbox/status');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /sync/conflicts — конфликты', async () => {
    const r = await api('GET', '/sync/conflicts');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  await check('GET /sync/instances — 1С подключения', async () => {
    const r = await api('GET', '/sync/instances');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(Array.isArray(r.data), `expected array, got ${typeof r.data}`);
  });

  // ─── ROLES ──────────────────────────────────────────────────────────────────
  section('ROLES / ПРАВА ДОСТУПА');

  await check('GET /roles — список ролей', async () => {
    const r = await api('GET', '/roles');
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(Array.isArray(r.data), `expected array`);
    assert(r.data.length >= 4, `expected ≥4 roles, got ${r.data.length}`);
  });

  await check('GET /roles/permissions — список прав', async () => {
    const r = await api('GET', '/roles/permissions');
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // ─── ИТОГ ───────────────────────────────────────────────────────────────────
  const total = passed + failed;
  log(`\n${'─'.repeat(52)}`);
  log(`${B}Результат: ${G}${passed}${X}${B}/${total} тестов прошло${X}`);
  if (failed > 0) {
    log(`${R}Не прошло: ${failed}${X}`);
    process.exit(1);
  } else {
    log(`${G}${B}Все тесты прошли! ✅${X}\n`);
  }
}

main().catch(e => { log(`\n${R}FATAL: ${e.message}${X}`); process.exit(1); });
