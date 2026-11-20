// Сквозной тест удалённого MCP (OAuth 2.1 + PKCE + Streamable HTTP) против запущенного API FlowPOS (dev):
// у каждой компании свой коннектор /mcp/c/<код>; войти может только её сотрудник; отключение действует сразу.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/http.js';

const API = process.env.FLOWPOS_API_URL || 'http://localhost:3000';
const EMAIL = process.env.FLOWPOS_EMAIL || 'admin@flowpos.kz';
const PASSWORD = process.env.FLOWPOS_PASSWORD || 'admin123';

const json = (method, path, { token, org, body } = {}) => fetch(`${API}/api/v1${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(org ? { 'X-Organization-Id': org } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test('MCP компании: подключение Claude, только сотрудник, отключение и выключение', async () => {
  // Владелец компании A и его коннектор
  const login = await json('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const ownerToken = login.body.accessToken;
  const ctxA = (await json('GET', '/accounting/context', { token: ownerToken })).body;
  const orgA = ctxA.organizationId;
  await json('PUT', '/ai/connector', { token: ownerToken, org: orgA, body: { enabled: true } });
  const codeA = (await json('GET', '/ai/connector', { token: ownerToken, org: orgA })).body.code;
  assert.match(codeA, /^[a-z2-9]{12}$/);

  // Компания B регистрируется на сайте (её сотрудник не должен попасть в компанию A)
  const suffix = Date.now().toString().slice(-9);
  const emailB = `mcp-b-${suffix}@example.com`;
  const passB = `Passw0rd-${suffix}`;
  const reg = await json('POST', '/auth/register', { body: { company: `ТОО Тест MCP ${suffix}`, bin: `900${suffix}`, firstName: 'Бек', lastName: 'Тестов', email: emailB, password: passB } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.ok(reg.body.accessToken);
  const orgB = reg.body.user.organizationId;
  const codeB = (await json('GET', '/ai/connector', { token: reg.body.accessToken, org: orgB })).body.code;
  // Повторная регистрация с тем же БИН — отказ
  assert.equal((await json('POST', '/auth/register', { body: { company: 'Дубль', bin: `900${suffix}`, firstName: 'А', lastName: 'Б', email: `x-${suffix}@example.com`, password: passB } })).status, 409);

  const srv = await new Promise((resolve) => { const s = createApp({ publicUrl: 'http://localhost:0', apiUrl: API, webUrl: 'http://localhost:5173', stateKey: 'x'.repeat(40), stateFile: null }).app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  const { app } = createApp({ publicUrl: `http://localhost:${port}`, apiUrl: API, webUrl: 'http://localhost:5173', stateKey: 'x'.repeat(40), stateFile: null });
  const server = await new Promise((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  const base = `http://localhost:${port}`;
  const urlA = `${base}/mcp/c/${codeA}`;
  try {
    // 1. Метаданные: сервер авторизации и ресурс компании
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(meta.issuer, `${base}/`);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/c/${codeA}`)).json();
    assert.equal(prm.resource, urlA);
    assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp/c/zzzzzzzzzzzz`)).status, 404);

    // 2. Общий /mcp не обслуживается; неизвестный код — 404; без токена — 401 с адресом метаданных компании
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/mcp/c/zzzzzzzzzzzz`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    const unauth = await fetch(urlA, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate') ?? '', new RegExp(`oauth-protected-resource/mcp/c/${codeA}`));

    // 3. Регистрация клиента (Claude)
    const redirect = 'http://localhost:9999/callback';
    const client = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude (тест)', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
    const token = (body) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

    // Вход: страница входа → логин/пароль → код → токены
    const authorize = async (resource, email, password) => {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const u = new URL(meta.authorization_endpoint);
      Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st', scope: 'flowpos', ...(resource ? { resource } : {}) }).forEach(([k, v]) => u.searchParams.set(k, v));
      const page = await (await fetch(u, { redirect: 'manual' })).text();
      const pending = page.match(/name="pending" value="([^"]+)"/)[1];
      const res = await fetch(`${base}/consent`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending, email, password }) });
      if (res.status !== 302) return { page, error: await res.text() };
      const code = new URL(res.headers.get('location')).searchParams.get('code');
      const t = await (await token({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirect })).json();
      return { page, tokens: t };
    };
    const connect = async (url, tok) => {
      const c = new Client({ name: 'test', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
      return c;
    };

    // 4. Сотрудник компании B по адресу компании A — отказ на странице входа
    const foreign = await authorize(urlA, emailB, passB);
    assert.match(foreign.page, /компании/);
    assert.ok(!foreign.tokens);
    assert.match(foreign.error, /не сотрудник компании/);

    // 5. Владелец компании A — подключение, инструменты работают только с компанией A
    const a = await authorize(urlA, EMAIL, PASSWORD);
    assert.ok(a.tokens?.access_token, a.error);
    const ca = await connect(urlA, a.tokens.access_token);
    const names = (await ca.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('esf_invoices') && !names.includes('flowpos_switch_organization'), 'организацию в коннекторе компании не переключить');
    assert.ok(!names.some((n) => /post|storno|delete|sign|send/i.test(n)), 'нет инструментов проведения/подписания');
    const ctx = await ca.callTool({ name: 'flowpos_context', arguments: {} });
    assert.ok(!ctx.isError, ctx.content[0].text);
    assert.match(ctx.content[0].text, /только с этой компанией/);
    await ca.close();
    // Тот же токен по адресу компании B — отказ
    const wrong = await fetch(`${base}/mcp/c/${codeB}`, { method: 'POST', headers: { Authorization: `Bearer ${a.tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(wrong.status, 403);

    // 6. Подключение видно компании; отключение действует сразу
    const conns = (await json('GET', '/ai/connections', { token: ownerToken, org: orgA })).body;
    const mine = conns.find((c) => c.active && c.clientName === 'Claude (тест)');
    assert.ok(mine, JSON.stringify(conns));
    assert.equal((await json('DELETE', `/ai/connections/${mine.id}`, { token: ownerToken, org: orgA })).status, 200);
    const cr = await connect(urlA, a.tokens.access_token);
    const afterRevoke = await cr.callTool({ name: 'flowpos_context', arguments: {} });
    assert.ok(afterRevoke.isError);
    assert.match(afterRevoke.content[0].text, /отключено/);
    await cr.close();

    // 7. Вход без resource (старые клиенты): грант привязывается к компании при первом запросе
    const b = await authorize(undefined, EMAIL, PASSWORD);
    const cb = await connect(urlA, b.tokens.access_token);
    assert.ok(!(await cb.callTool({ name: 'flowpos_context', arguments: {} })).isError);
    await cb.close();

    // 8. Помощник выключен компанией — коннектор отвечает отказом
    await json('PUT', '/ai/connector', { token: ownerToken, org: orgA, body: { enabled: false } });
    await new Promise((r) => setTimeout(r, 31_000)); // кэш адреса — 30 секунд
    const off = await fetch(urlA, { method: 'POST', headers: { Authorization: `Bearer ${b.tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(off.status, 403);
  } finally {
    await json('PUT', '/ai/connector', { token: ownerToken, org: orgA, body: { enabled: true } });
    await new Promise((r) => server.close(r));
  }
});
