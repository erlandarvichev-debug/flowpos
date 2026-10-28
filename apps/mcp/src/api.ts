/**
 * Клиент REST API FlowPOS. Все запросы идут от имени пользователя (его JWT), поэтому
 * права MCP-инструментов совпадают с правами пользователя в организации. Прямого доступа к БД нет.
 */
export interface ApiConfig {
  baseUrl: string;
  token?: string;
  email?: string;
  password?: string;
  organizationId?: string;
  /** Режим удалённого MCP: сессия пользователя по refresh-cookie FlowPOS (ротация на каждом обновлении). */
  refreshToken?: string;
  onSession?: (s: { refreshToken: string; organizationId?: string }) => void | Promise<void>;
}

const REFRESH_COOKIE = 'fp_refresh';

/** Значение refresh-cookie из ответа FlowPOS (Set-Cookie). */
export function refreshFromResponse(res: Response): string | undefined {
  const all: string[] = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  for (const c of all) {
    const m = c.match(new RegExp(`(?:^|,\\s*)${REFRESH_COOKIE}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}

/** Вход в FlowPOS по логину и паролю: JWT + refresh-токен сессии. Пароль дальше не используется. */
export async function loginFlowPos(baseUrl: string, email: string, password: string) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.accessToken) throw new ApiError(res.status, body);
  const refreshToken = refreshFromResponse(res);
  if (!refreshToken) throw new Error('FlowPOS не выдал ключ обновления сессии');
  return { accessToken: body.accessToken as string, refreshToken, user: body.user };
}

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(typeof body?.message === 'string' ? body.message : `HTTP ${status}`);
  }
}

export class FlowPosApi {
  private token?: string;
  constructor(private cfg: ApiConfig) {
    this.token = cfg.token;
  }

  get organizationId() {
    return this.cfg.organizationId;
  }

  setOrganization(id: string) {
    this.cfg.organizationId = id;
    if (this.cfg.refreshToken) void this.cfg.onSession?.({ refreshToken: this.cfg.refreshToken, organizationId: id });
  }

  /** Обновление JWT по refresh-cookie; FlowPOS ротирует refresh-токен — новый сохраняем. */
  private async refresh() {
    const res = await fetch(`${this.cfg.baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `${REFRESH_COOKIE}=${encodeURIComponent(this.cfg.refreshToken!)}` },
      signal: AbortSignal.timeout(20000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.accessToken) throw new ApiError(401, { message: 'Сессия FlowPOS истекла — переподключите FlowPOS в Claude' });
    this.token = body.accessToken;
    const next = refreshFromResponse(res);
    if (next && next !== this.cfg.refreshToken) {
      this.cfg.refreshToken = next;
      await this.cfg.onSession?.({ refreshToken: next, organizationId: this.cfg.organizationId });
    }
  }

  private inflight?: Promise<void>;

  /** Параллельные запросы делят одно обновление: FlowPOS ротирует refresh-токен, второй запрос со старым получил бы отказ. */
  private async login() {
    if (this.cfg.refreshToken) {
      this.inflight ??= this.refresh().finally(() => { this.inflight = undefined; });
      return this.inflight;
    }
    if (!this.cfg.email || !this.cfg.password) {
      throw new Error('Нет доступа к FlowPOS: задайте FLOWPOS_TOKEN или FLOWPOS_EMAIL + FLOWPOS_PASSWORD');
    }
    const res = await fetch(`${this.cfg.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
      signal: AbortSignal.timeout(20000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.accessToken) throw new ApiError(res.status, body);
    this.token = body.accessToken;
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, any>; body?: any; idempotencyKey?: string } = {}, retried = false): Promise<T> {
    if (!this.token) await (this.inflight ?? this.login());
    const url = new URL(`${this.cfg.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const sentToken = this.token;
    const headers: Record<string, string> = { Authorization: `Bearer ${sentToken}`, 'Content-Type': 'application/json' };
    if (this.cfg.organizationId) headers['X-Organization-Id'] = this.cfg.organizationId;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(60000) });
    if (res.status === 401 && !retried && (this.cfg.email || this.cfg.refreshToken)) {
      if (this.token === sentToken) this.token = undefined; // другой запрос мог уже обновить JWT
      return this.request(method, path, opts, true);
    }
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }
}
