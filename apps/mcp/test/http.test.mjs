// Сквозной тест удалённого MCP (OAuth 2.1 + PKCE + Streamable HTTP) против запущенного API FlowPOS (dev).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/http.js';

const API = process.env.FLOWPOS_API_URL || 'http://localhost:3000';
const EMAIL = process.env.FLOWPOS_EMAIL || 'admin@flowpos.kz';
const PASSWORD = process.env.FLOWPOS_PASSWORD || 'admin123';

test('удалённый MCP: подключение Claude по OAuth и работа инструментов с правами пользователя', async () => {
  const srv = await new Promise((resolve) => {
    const s = createApp({ publicUrl: 'http://localhost:0', apiUrl: API, webUrl: 'http://localhost:5173', stateKey: 'x'.repeat(40), stateFile: null }).app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  // publicUrl должен совпадать с реальным адресом — пересоздаём приложение с верным портом
  await new Promise((r) => srv.close(r));
  const { app } = createApp({ publicUrl: `http://localhost:${port}`, apiUrl: API, webUrl: 'http://localhost:5173', stateKey: 'x'.repeat(40), stateFile: null });
  const server = await new Promise((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  const base = `http://localhost:${port}`;
  try {
    // 1. Метаданные
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(meta.issuer, `${base}/`);
    assert.ok(meta.code_challenge_methods_supported.includes('S256'));
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`);

    // 2. Без токена — 401 с адресом метаданных
    const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata=/);

    // 3. Динамическая регистрация клиента
    const redirect = 'http://localhost:9999/callback';
    const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude (тест)', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
    assert.ok(reg.client_id);

    // 4. Авторизация с PKCE → страница входа FlowPOS
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authUrl = new URL(meta.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope: 'flowpos', resource: `${base}/mcp` }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const page = await (await fetch(authUrl, { redirect: 'manual' })).text();
    assert.match(page, /Подключить FlowPOS/);
    assert.match(page, /Claude \(тест\)/);
    const pending = page.match(/name="pending" value="([^"]+)"/)[1];

    // 5. Неверный пароль — та же страница с ошибкой; верный — редирект с кодом
    const consent = (pw) => fetch(`${base}/consent`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending, email: EMAIL, password: pw }) });
    const bad = await consent('wrong-password');
    assert.equal(bad.status, 200);
    assert.match(await bad.text(), /Неверный e-mail или пароль/);
    const ok = await consent(PASSWORD);
    assert.equal(ok.status, 302);
    const loc = new URL(ok.headers.get('location'));
    assert.equal(`${loc.origin}${loc.pathname}`, redirect);
    assert.equal(loc.searchParams.get('state'), 'st-1');
    const code = loc.searchParams.get('code');

    // 6. Обмен кода на токены (PKCE проверяется), повтор кода запрещён
    const token = (body) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const badPkce = await token({ grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: 'x'.repeat(43), redirect_uri: redirect });
    assert.equal(badPkce.status, 400);
    const t1 = await (await token({ grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: redirect })).json();
    assert.ok(t1.access_token && t1.refresh_token, JSON.stringify(t1));
    const reuse = await token({ grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: redirect });
    assert.equal(reuse.status, 400);

    // 7. MCP с токеном: инструменты и данные пользователя
    const connect = async (tok) => {
      const c = new Client({ name: 'test', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
      return c;
    };
    const client = await connect(t1.access_token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('esf_invoices') && names.includes('accounting_trial_balance'));
    assert.ok(!names.some((n) => /post|storno|delete|sign|send/i.test(n)), 'нет инструментов проведения/подписания');
    const ctx = await client.callTool({ name: 'flowpos_context', arguments: {} });
    assert.ok(!ctx.isError, ctx.content[0].text);
    assert.match(ctx.content[0].text, /роль/);
    await client.close();

    // 8. Обновление токена с ротацией: старый refresh больше не действует
    const t2 = await (await token({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: t1.refresh_token })).json();
    assert.ok(t2.access_token && t2.access_token !== t1.access_token);
    assert.equal((await token({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: t1.refresh_token })).status, 400);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${t1.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 401);

    // 9. Отзыв доступа
    await fetch(meta.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t2.access_token, client_id: reg.client_id }) });
    const after = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${t2.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(after.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
