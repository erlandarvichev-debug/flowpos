/**
 * Хранилище OAuth удалённого MCP: зарегистрированные клиенты (Claude и др.), коды авторизации, гранты.
 * Один процесс — один JSON-файл (права 600). Токены MCP хранятся только как SHA-256;
 * refresh-токен сессии FlowPOS — зашифрован AES-256-GCM ключом MCP_STATE_KEY. Пароли не хранятся.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface Grant {
  id: string;
  clientId: string;
  userId: string;
  email: string;
  organizationId?: string;
  scopes: string[];
  sessionEnc: string; // зашифрованный refresh-токен FlowPOS
  accessHash?: string;
  accessExpiresAt?: number;
  refreshHash?: string;
  refreshExpiresAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

export interface AuthCode {
  codeHash: string;
  clientId: string;
  grantId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  expiresAt: number;
}

interface Data {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, AuthCode>;
  grants: Record<string, Grant>;
  pending: Record<string, PendingAuthorization>;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export class Store {
  private data: Data = { clients: {}, codes: {}, grants: {}, pending: {} };
  private key: Buffer;

  constructor(private file: string | null, stateKey: string) {
    if (!stateKey || stateKey.length < 32) throw new Error('MCP_STATE_KEY: нужен секрет не короче 32 символов');
    this.key = createHash('sha256').update(stateKey).digest();
    if (file && existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) };
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  encrypt(plain: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(blob: string) {
    const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }

  /** Удаление просроченного: коды, ожидающие входа, гранты с истёкшим refresh-токеном. */
  sweep(now = Date.now()) {
    let changed = false;
    for (const [k, v] of Object.entries(this.data.codes)) if (v.expiresAt < now) { delete this.data.codes[k]; changed = true; }
    for (const [k, v] of Object.entries(this.data.pending)) if (v.expiresAt < now) { delete this.data.pending[k]; changed = true; }
    for (const [k, v] of Object.entries(this.data.grants)) if ((v.refreshExpiresAt ?? 0) < now && (v.accessExpiresAt ?? 0) < now) { delete this.data.grants[k]; changed = true; }
    if (changed) this.save();
  }

  // клиенты (динамическая регистрация RFC 7591)
  getClient(id: string) { return this.data.clients[id]; }
  saveClient(c: OAuthClientInformationFull) { this.data.clients[c.client_id] = c; this.save(); return c; }

  // ожидающие входа пользователя
  savePending(p: PendingAuthorization) { this.data.pending[p.id] = p; this.save(); }
  takePending(id: string) { const p = this.data.pending[id]; if (p) { delete this.data.pending[id]; this.save(); } return p && p.expiresAt > Date.now() ? p : undefined; }

  // коды авторизации (одноразовые)
  saveCode(c: AuthCode) { this.data.codes[c.codeHash] = c; this.save(); }
  peekCode(code: string) { const c = this.data.codes[sha256(code)]; return c && c.expiresAt > Date.now() ? c : undefined; }
  takeCode(code: string) { const h = sha256(code); const c = this.data.codes[h]; if (c) { delete this.data.codes[h]; this.save(); } return c && c.expiresAt > Date.now() ? c : undefined; }

  // гранты
  saveGrant(g: Grant) { this.data.grants[g.id] = g; this.save(); return g; }
  getGrant(id: string) { return this.data.grants[id]; }
  deleteGrant(id: string) { delete this.data.grants[id]; this.save(); }
  grantByAccess(token: string) { const h = sha256(token); return Object.values(this.data.grants).find((g) => g.accessHash === h); }
  grantByRefresh(token: string) { const h = sha256(token); return Object.values(this.data.grants).find((g) => g.refreshHash === h); }
  touch(g: Grant) { g.lastUsedAt = Date.now(); }
  grantsOf(userId: string) { return Object.values(this.data.grants).filter((g) => g.userId === userId); }
}
