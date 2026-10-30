// FP-008: вход через внешний провайдер OIDC (Keycloak, Azure AD, Google Workspace и т. п.).
// Authorization Code + PKCE (S256), одноразовые state/nonce на сервере, проверка id_token по JWKS провайдера.
// Учётная запись провайдера связывается с пользователем FlowPOS только явно (вошедшим пользователем) —
// по (issuer, subject), не по email: совпадение email у провайдера не доказывает владение учётной записью.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { KeyObject, createHash, createPublicKey, randomBytes, verify as cryptoVerify, constants } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService, ClientInfo } from './auth.service';

export const OIDC_STATE_TTL_MS = 10 * 60_000;
/** Допуск расхождения часов с провайдером. */
const CLOCK_SKEW_S = 60;
/** Методы аутентификации (RFC 8176), которые считаются вторым фактором. */
const MFA_AMR = new Set(['mfa', 'otp', 'hwk', 'swk', 'sms', 'fpt', 'face', 'iris', 'retina', 'sc']);
const ALLOWED_ALGS = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512']);

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
}

/** Настройки из окружения. Нет OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_REDIRECT_URI — вход через провайдера выключен. */
export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/+$/, '');
  const clientId = process.env.OIDC_CLIENT_ID;
  const redirectUri = process.env.OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !redirectUri) return null;
  return { issuer, clientId, clientSecret: process.env.OIDC_CLIENT_SECRET || undefined, redirectUri, scopes: process.env.OIDC_SCOPES || 'openid email profile' };
}

const err = (code: string, message: string) => ({ code, message });
const b64url = (b: Buffer) => b.toString('base64url');

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

@Injectable()
export class OidcService {
  private discovery?: { at: number; issuer: string; doc: Discovery };
  private jwks?: { at: number; uri: string; keys: Map<string, KeyObject> };

  constructor(private prisma: PrismaService, private auth: AuthService) {}

  private cfg(): OidcConfig {
    const c = oidcConfig();
    if (!c) throw new BadRequestException(err('OIDC_DISABLED', 'Вход через внешнего провайдера не настроен'));
    return c;
  }

  private async fetchJson(url: string, init?: RequestInit) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new UnauthorizedException(err('OIDC_PROVIDER_ERROR', `Провайдер входа ответил ${res.status}`));
    return body;
  }

  private async provider(c: OidcConfig): Promise<Discovery> {
    if (this.discovery && this.discovery.issuer === c.issuer && Date.now() - this.discovery.at < 5 * 60_000) return this.discovery.doc;
    const doc = (await this.fetchJson(`${c.issuer}/.well-known/openid-configuration`)) as Discovery;
    if (doc.issuer?.replace(/\/+$/, '') !== c.issuer) throw new UnauthorizedException(err('OIDC_ISSUER_MISMATCH', 'Провайдер представился другим издателем'));
    this.discovery = { at: Date.now(), issuer: c.issuer, doc };
    return doc;
  }

  private async key(doc: Discovery, kid: string | undefined): Promise<KeyObject> {
    const load = async () => {
      const { keys } = await this.fetchJson(doc.jwks_uri);
      const map = new Map<string, KeyObject>();
      for (const jwk of keys ?? []) if (jwk.use !== 'enc') map.set(jwk.kid ?? '', createPublicKey({ key: jwk, format: 'jwk' }));
      this.jwks = { at: Date.now(), uri: doc.jwks_uri, keys: map };
    };
    if (!this.jwks || this.jwks.uri !== doc.jwks_uri || Date.now() - this.jwks.at > 60 * 60_000) await load();
    let k = this.jwks!.keys.get(kid ?? '');
    if (!k) {
      await load(); // провайдер мог сменить ключи
      k = this.jwks!.keys.get(kid ?? '');
    }
    if (!k) throw new UnauthorizedException(err('OIDC_KEY_UNKNOWN', 'Неизвестный ключ подписи провайдера'));
    return k;
  }

  /** Проверка id_token: подпись по JWKS (только асимметричные алгоритмы), издатель, получатель, срок, nonce. */
  async verifyIdToken(idToken: string, nonce: string, c: OidcConfig, doc: Discovery, nowS = Math.floor(Date.now() / 1000)) {
    const parts = String(idToken ?? '').split('.');
    if (parts.length !== 3) throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', 'Неверный id_token'));
    let header: any, claims: any;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch {
      throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', 'Неверный id_token'));
    }
    if (!ALLOWED_ALGS.has(header.alg)) throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', `Недопустимый алгоритм подписи ${header.alg}`));
    const key = await this.key(doc, header.kid);
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    const hash = `sha${header.alg.slice(2)}`;
    const ok = header.alg.startsWith('ES')
      ? cryptoVerify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : header.alg.startsWith('PS')
        ? cryptoVerify(hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, sig)
        : cryptoVerify(hash, data, key, sig);
    if (!ok) throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', 'Подпись id_token не прошла проверку'));

    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss?.replace(/\/+$/, '') !== c.issuer) throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', 'id_token другого издателя'));
    if (!aud.includes(c.clientId) || (aud.length > 1 && claims.azp !== c.clientId)) throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', 'id_token выдан другому приложению'));
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw new UnauthorizedException(err('OIDC_TOKEN_EXPIRED', 'id_token истёк'));
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', 'id_token выдан в будущем'));
    if (!claims.sub) throw new UnauthorizedException(err('OIDC_TOKEN_INVALID', 'В id_token нет subject'));
    if (claims.nonce !== nonce) throw new UnauthorizedException(err('OIDC_NONCE_MISMATCH', 'id_token не относится к этому входу'));
    return claims as { iss: string; sub: string; email?: string; amr?: string[] };
  }

  /** Начать вход или привязку: одноразовое состояние на сервере и адрес авторизации провайдера. */
  async start(purpose: 'login' | 'link', userId?: string) {
    const c = this.cfg();
    const doc = await this.provider(c);
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const codeVerifier = b64url(randomBytes(48));
    await this.prisma.oidcState.create({ data: { state, nonce, codeVerifier, purpose, userId: userId ?? null, expiresAt: new Date(Date.now() + OIDC_STATE_TTL_MS) } });
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope: c.scopes, state, nonce,
      code_challenge: b64url(createHash('sha256').update(codeVerifier).digest()), code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /**
   * Возврат от провайдера. Состояние используется один раз (условное обновление), код меняется на токены
   * с PKCE verifier, id_token проверяется. Вход — только для привязанной учётной записи; привязка — к тому,
   * кто её начал.
   */
  async callback(code: string, state: string, client: ClientInfo = {}) {
    const c = this.cfg();
    if (!code || !state) throw new BadRequestException(err('OIDC_BAD_CALLBACK', 'Нет code или state'));
    const st = await this.prisma.oidcState.findUnique({ where: { state } });
    if (!st || st.expiresAt < new Date()) throw new BadRequestException(err('OIDC_STATE_INVALID', 'Вход устарел или не начинался здесь — начните заново'));
    const { count } = await this.prisma.oidcState.updateMany({ where: { state, usedAt: null }, data: { usedAt: new Date() } });
    if (count !== 1) throw new BadRequestException(err('OIDC_STATE_INVALID', 'Этот вход уже завершён — начните заново'));

    const doc = await this.provider(c);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, client_id: c.clientId, code_verifier: st.codeVerifier });
    if (c.clientSecret) form.set('client_secret', c.clientSecret);
    const tokens = await this.fetchJson(doc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    const claims = await this.verifyIdToken(tokens.id_token, st.nonce, c, doc);
    const mfaAt = (claims.amr ?? []).some((m) => MFA_AMR.has(m)) ? new Date() : null;

    if (st.purpose === 'link') {
      const user = await this.prisma.user.findUnique({ where: { id: st.userId ?? '' } });
      if (!user || !user.isActive) throw new ForbiddenException(err('OIDC_LINK_INVALID', 'Привязку начал неактивный пользователь'));
      const existing = await this.prisma.userIdentity.findUnique({ where: { issuer_subject: { issuer: claims.iss, subject: claims.sub } } });
      if (existing && existing.userId !== user.id) throw new ConflictException(err('OIDC_ALREADY_LINKED', 'Эта учётная запись провайдера уже привязана к другому пользователю'));
      if (!existing) {
        await this.prisma.userIdentity.create({ data: { tenantId: user.tenantId, userId: user.id, issuer: claims.iss, subject: claims.sub, email: claims.email ?? null } });
        await this.prisma.auditLog.create({ data: { userId: user.id, organizationId: user.organizationId, action: 'OIDC_LINKED', entity: 'User', entityId: user.id, after: { issuer: claims.iss } } });
      }
      return { purpose: 'link' as const };
    }

    const identity = await this.prisma.userIdentity.findUnique({ where: { issuer_subject: { issuer: claims.iss, subject: claims.sub } } });
    if (!identity) throw new ForbiddenException(err('OIDC_NOT_LINKED', 'Учётная запись провайдера не привязана: войдите паролем и привяжите её в профиле'));
    await this.prisma.userIdentity.update({ where: { id: identity.id }, data: { lastLoginAt: new Date() } });
    const session = await this.auth.openSession(identity.userId, 'oidc', client, mfaAt);
    return { purpose: 'login' as const, ...session };
  }

  async identities(userId: string) {
    return this.prisma.userIdentity.findMany({ where: { userId }, select: { id: true, issuer: true, email: true, createdAt: true, lastLoginAt: true } });
  }

  async unlink(userId: string, id: string) {
    const { count } = await this.prisma.userIdentity.deleteMany({ where: { id, userId } });
    if (!count) throw new BadRequestException(err('OIDC_NOT_FOUND', 'Привязка не найдена'));
    return { ok: true };
  }
}
