/**
 * OAuth 2.1 для удалённого MCP FlowPOS (авторизационный сервер + проверка токенов).
 * Поток: Claude регистрирует себя (DCR) → /authorize → страница входа FlowPOS → пользователь вводит
 * свои логин и пароль → FlowPOS выдаёт сессию → мы выдаём Claude код → токены MCP (PKCE обязателен).
 * MCP-токен привязан к сессии пользователя FlowPOS: права в Claude = права пользователя в FlowPOS.
 */
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Grant, Store, randomToken, sha256 } from './store.js';

export const SCOPE = 'flowpos';
const ACCESS_TTL = 60 * 60 * 1000; // 1 час
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней — как сессия FlowPOS
const CODE_TTL = 5 * 60 * 1000;
const PENDING_TTL = 10 * 60 * 1000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class FlowPosOAuthProvider implements OAuthServerProvider {
  constructor(private store: Store) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.getClient(id),
      registerClient: (c) => this.store.saveClient({ ...c, client_id: randomToken(16), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull),
    };
  }

  /** Показываем страницу входа FlowPOS; форма отправляется на /consent вместе с id ожидающей авторизации. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = randomToken(24);
    this.store.savePending({ id, clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, state: params.state, scopes: params.scopes?.length ? params.scopes : [SCOPE], expiresAt: Date.now() + PENDING_TTL });
    res.status(200).type('html').send(loginPage({ pendingId: id, clientName: client.client_name || 'ИИ-ассистент', redirectHost: new URL(params.redirectUri).host }));
  }

  /** Пользователь вошёл в FlowPOS — создаём грант и код авторизации. Возвращает URL для редиректа. */
  completeAuthorization(pendingId: string, session: { userId: string; email: string; organizationId?: string; refreshToken: string }): string {
    const p = this.store.takePending(pendingId);
    if (!p) throw new Error('Страница входа устарела — начните подключение заново');
    const grant: Grant = { id: randomToken(16), clientId: p.clientId, userId: session.userId, email: session.email, organizationId: session.organizationId, scopes: p.scopes, sessionEnc: this.store.encrypt(session.refreshToken), createdAt: Date.now() };
    this.store.saveGrant(grant);
    const code = randomToken(32);
    this.store.saveCode({ codeHash: sha256(code), clientId: p.clientId, grantId: grant.id, codeChallenge: p.codeChallenge, redirectUri: p.redirectUri, expiresAt: Date.now() + CODE_TTL });
    const url = new URL(p.redirectUri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    return url.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.store.peekCode(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Неверный или просроченный код авторизации');
    return c.codeChallenge;
  }

  private issue(g: Grant): OAuthTokens {
    const access = randomToken(32), refresh = randomToken(32);
    g.accessHash = sha256(access);
    g.accessExpiresAt = Date.now() + ACCESS_TTL;
    g.refreshHash = sha256(refresh);
    g.refreshExpiresAt = Date.now() + REFRESH_TTL;
    this.store.saveGrant(g);
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: g.scopes.join(' ') };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.store.takeCode(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Неверный или просроченный код авторизации');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri не совпадает');
    const g = this.store.getGrant(c.grantId);
    if (!g) throw new InvalidGrantError('Доступ отозван');
    return this.issue(g);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const g = this.store.grantByRefresh(refreshToken);
    if (!g || g.clientId !== client.client_id || (g.refreshExpiresAt ?? 0) < Date.now()) throw new InvalidGrantError('Ключ обновления недействителен — подключите FlowPOS заново');
    return this.issue(g); // ротация: старый refresh больше не работает
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const g = this.store.grantByAccess(token);
    if (!g || (g.accessExpiresAt ?? 0) < Date.now()) throw new InvalidTokenError('Invalid or expired token'); // текст уходит в заголовок WWW-Authenticate — только ASCII
    this.store.touch(g);
    return { token, clientId: g.clientId, scopes: g.scopes, expiresAt: Math.floor((g.accessExpiresAt ?? 0) / 1000), extra: { grantId: g.id } };
  }

  async revokeToken(_client: OAuthClientInformationFull, req: OAuthTokenRevocationRequest): Promise<void> {
    const g = this.store.grantByAccess(req.token) ?? this.store.grantByRefresh(req.token);
    if (g) this.store.deleteGrant(g.id);
  }
}

export function loginPage(o: { pendingId: string; clientName: string; redirectHost: string; error?: string; email?: string }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключение FlowPOS</title>
<style>
:root{--bg:#f4f6fa;--card:#fff;--text:#1f2329;--muted:#6b7280;--accent:#2563eb;--err:#dc2626;--border:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#111827;--text:#e5e7eb;--muted:#9ca3af;--accent:#60a5fa;--err:#f87171;--border:#1f2937}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 6px}.muted{color:var(--muted);font-size:13px}label{display:block;margin:14px 0 6px;font-size:13px}
input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);font-size:15px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:15px;cursor:pointer}
.err{color:var(--err);margin-top:12px;font-size:14px}ul{padding-left:18px;margin:10px 0 0}li{margin:2px 0}
</style></head><body><form class="card" method="post" action="consent" autocomplete="on">
<h1>⚡ Подключить FlowPOS</h1>
<div class="muted"><b>${esc(o.clientName)}</b> (${esc(o.redirectHost)}) просит доступ к вашему FlowPOS.</div>
<ul class="muted"><li>видеть отчёты, остатки, документы, ЭСФ — в пределах ваших прав;</li><li>создавать черновики документов;</li><li>проводить, подписывать и удалять ИИ не сможет.</li></ul>
<input type="hidden" name="pending" value="${esc(o.pendingId)}">
<label for="e">E-mail в FlowPOS</label><input id="e" name="email" type="email" required value="${esc(o.email ?? '')}">
<label for="p">Пароль</label><input id="p" name="password" type="password" required>
${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
<button type="submit">Войти и разрешить</button>
<p class="muted">Пароль передаётся только в FlowPOS и не сохраняется. Отключить доступ можно в настройках коннекторов Claude.</p>
</form></body></html>`;
}
