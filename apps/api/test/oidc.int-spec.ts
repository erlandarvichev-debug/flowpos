// FP-008: вход через внешнего провайдера (OIDC) — поддельный провайдер в тесте (discovery, JWKS, token endpoint
// с проверкой PKCE). Привязка только явная, по (issuer, subject); state одноразовый; id_token проверяется строго.
import { createServer, Server } from 'http';
import { createHash, createSign, generateKeyPairSync, KeyObject } from 'crypto';
import { AddressInfo } from 'net';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { HttpApp, call, login, makeUser, startApp, uid } from './http-app';

let h: HttpApp;
let idp: Server;
let issuer: string;
let org: string;
const CLIENT = 'flowpos-test';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
type Grant = { challenge: string; claims: Record<string, unknown>; signer?: KeyObject; header?: Record<string, unknown> };
const grants = new Map<string, Grant>();

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims: Record<string, unknown>, signer: KeyObject = key.privateKey, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) {
  const head = b64(header);
  const body = b64(claims);
  if (header.alg === 'none') return `${head}.${body}.`;
  const s = createSign('sha256').update(`${head}.${body}`).sign(signer).toString('base64url');
  return `${head}.${body}.${s}`;
}

beforeAll(async () => {
  idp = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const f = new URLSearchParams(raw);
        const g = grants.get(f.get('code') ?? '');
        grants.delete(f.get('code') ?? '');
        if (!g || f.get('client_id') !== CLIENT) return json(400, { error: 'invalid_grant' });
        const challenge = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (challenge !== g.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
        json(200, { access_token: 'x', token_type: 'Bearer', id_token: sign(g.claims, g.signer, g.header) });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  Object.assign(process.env, { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT, OIDC_REDIRECT_URI: 'http://api.test/api/v1/auth/oidc/callback', OIDC_WEB_REDIRECT: 'http://web.test/login' });
  h = await startApp();
  await defaultTenant(h.prisma);
  org = (await h.prisma.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `OIDC ${uid()}` } })).id;
}, 60_000);

afterAll(async () => {
  for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI', 'OIDC_WEB_REDIRECT']) delete process.env[k];
  await h?.app.close();
  await new Promise((r) => idp?.close(r));
});

/** Пройти авторизацию у провайдера: из адреса авторизации взять state/nonce/challenge, выдать код с нужными claims. */
function authorize(authorizeUrl: string, claims: (nonce: string) => Record<string, unknown>, opts: Partial<Grant> & { challenge?: string } = {}) {
  const u = new URL(authorizeUrl);
  expect(u.origin + u.pathname).toBe(`${issuer}/authorize`);
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  const code = `code-${uid()}`;
  grants.set(code, { challenge: opts.challenge ?? u.searchParams.get('code_challenge')!, claims: claims(u.searchParams.get('nonce')!), signer: opts.signer, header: opts.header });
  return { code, state: u.searchParams.get('state')! };
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (sub: string, extra: Record<string, unknown> = {}) => (nonce: string) => ({ iss: issuer, aud: CLIENT, sub, nonce, iat: now(), exp: now() + 300, email: 'x@idp.test', ...extra });
const startLogin = async () => (await call(h, 'GET', '/auth/oidc/login', { redirect: 'manual' })).location!;
const callback = (code: string, state: string) => call(h, 'GET', `/auth/oidc/callback?code=${code}&state=${state}`, { redirect: 'manual' });
const resultOf = (r: { location?: string }) => {
  const u = new URL(r.location!);
  return u.searchParams.get('oidc') ?? `error:${u.searchParams.get('oidc_error')}`;
};

async function linkedUser(sub: string) {
  const u = await makeUser(h, DEFAULT_TENANT, org, { role: 'cashier' });
  const { token } = await login(h, u.email);
  const { url } = (await call(h, 'POST', '/auth/oidc/link', { token })).body;
  const { code, state } = authorize(url, goodClaims(sub));
  expect(resultOf(await callback(code, state))).toBe('linked');
  return { ...u, token };
}

describe('FP-008: вход через OIDC', () => {
  it('выключен без настроек; с настройками — переход к провайдеру с PKCE S256', async () => {
    expect((await call(h, 'GET', '/auth/oidc/config')).body.enabled).toBe(true);
    const loc = await startLogin();
    const u = new URL(loc);
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
    expect(u.searchParams.get('state')).toHaveLength(32);
    expect(u.searchParams.get('nonce')).toHaveLength(32);
  });

  it('учётная запись провайдера без привязки не входит — даже если email совпадает с пользователем FlowPOS', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, org, { role: 'cashier' });
    const { code, state } = authorize(await startLogin(), goodClaims(`sub-${uid()}`, { email: u.email, email_verified: true }));
    expect(resultOf(await callback(code, state))).toBe('error:OIDC_NOT_LINKED');
  });

  it('привязка вошедшим пользователем, затем вход: refresh-токен в cookie, access — через /auth/refresh', async () => {
    const sub = `sub-${uid()}`;
    const u = await linkedUser(sub);
    const { code, state } = authorize(await startLogin(), goodClaims(sub));
    const r = await callback(code, state);
    expect(resultOf(r)).toBe('ok');
    expect(r.location).not.toContain('token');
    const refresh = await call(h, 'POST', '/auth/refresh', { cookie: `fp_refresh=${r.cookie('fp_refresh')}` });
    const me = await call(h, 'GET', '/auth/me', { token: refresh.body.accessToken });
    expect([me.status, me.body.id]).toEqual([200, u.id]);
    const session = await h.prisma.authSession.findFirstOrThrow({ where: { userId: u.id, authMethod: 'oidc' } });
    expect(session.mfaAt).toBeNull();
  });

  it('state одноразовый и с ограниченным сроком', async () => {
    const sub = `sub-${uid()}`;
    await linkedUser(sub);
    const { code, state } = authorize(await startLogin(), goodClaims(sub));
    expect(resultOf(await callback(code, state))).toBe('ok');
    const again = authorize(await startLogin(), goodClaims(sub));
    expect(resultOf(await callback(again.code, state))).toBe('error:OIDC_STATE_INVALID'); // старый state
    expect(resultOf(await callback(again.code, 'чужой-state'))).toBe('error:OIDC_STATE_INVALID');
    await h.prisma.oidcState.update({ where: { state: again.state }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(resultOf(await callback(again.code, again.state))).toBe('error:OIDC_STATE_INVALID');
  });

  it.each([
    ['чужой nonce', { nonce: 'другой' }, 'OIDC_NONCE_MISMATCH'],
    ['другое приложение (aud)', { aud: 'чужой-клиент' }, 'OIDC_TOKEN_INVALID'],
    ['другой издатель (iss)', { iss: 'https://evil.test' }, 'OIDC_TOKEN_INVALID'],
    ['истёкший', { exp: Math.floor(Date.now() / 1000) - 3600 }, 'OIDC_TOKEN_EXPIRED'],
  ])('id_token: %s — отказ', async (_name, override, code) => {
    const sub = `sub-${uid()}`;
    await linkedUser(sub);
    const g = authorize(await startLogin(), (nonce) => ({ ...goodClaims(sub)(nonce), ...override }));
    expect(resultOf(await callback(g.code, g.state))).toBe(`error:${code}`);
  });

  it('id_token: подпись другим ключом и alg=none — отказ; PKCE не совпал — провайдер не выдаёт токен', async () => {
    const sub = `sub-${uid()}`;
    await linkedUser(sub);
    const forged = authorize(await startLogin(), goodClaims(sub), { signer: otherKey.privateKey });
    expect(resultOf(await callback(forged.code, forged.state))).toBe('error:OIDC_TOKEN_INVALID');
    const none = authorize(await startLogin(), goodClaims(sub), { header: { alg: 'none', kid: 'k1' } });
    expect(resultOf(await callback(none.code, none.state))).toBe('error:OIDC_TOKEN_INVALID');
    const pkce = authorize(await startLogin(), goodClaims(sub), { challenge: 'не-тот-challenge' });
    expect(resultOf(await callback(pkce.code, pkce.state))).toBe('error:OIDC_PROVIDER_ERROR');
  });

  it('второй фактор у провайдера (amr) — сессия подтверждена MFA', async () => {
    const sub = `sub-${uid()}`;
    const u = await linkedUser(sub);
    const g = authorize(await startLogin(), goodClaims(sub, { amr: ['pwd', 'otp'] }));
    expect(resultOf(await callback(g.code, g.state))).toBe('ok');
    expect((await h.prisma.authSession.findFirstOrThrow({ where: { userId: u.id, authMethod: 'oidc' } })).mfaAt).not.toBeNull();
  });

  it('учётную запись провайдера нельзя привязать ко второму пользователю; отключённый пользователь не входит', async () => {
    const sub = `sub-${uid()}`;
    const first = await linkedUser(sub);
    const other = await makeUser(h, DEFAULT_TENANT, org, { role: 'cashier' });
    const { url } = (await call(h, 'POST', '/auth/oidc/link', { token: (await login(h, other.email)).token })).body;
    const g = authorize(url, goodClaims(sub));
    expect(resultOf(await callback(g.code, g.state))).toBe('error:OIDC_ALREADY_LINKED');

    await h.prisma.user.update({ where: { id: first.id }, data: { isActive: false } });
    const l = authorize(await startLogin(), goodClaims(sub));
    expect(resultOf(await callback(l.code, l.state))).toBe('error:OIDC_FAILED');
  });
});
