// FP-008 приёмка «Revoke и expiry работают»: серверная сессия, короткий access-токен, ротация refresh-токена,
// отзыв при выходе/смене пароля/отключении/краже refresh-токена — через HTTP на настоящем приложении.
import { JwtService } from '@nestjs/jwt';
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { HttpApp, call, hashTokenForTest, login, makeUser, startApp, uid } from './http-app';

let h: HttpApp;
let orgId: string;

beforeAll(async () => {
  h = await startApp();
  await defaultTenant(h.prisma);
  orgId = (await h.prisma.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `Сессии ${uid()}` } })).id;
}, 60_000);
afterAll(async () => h?.app.close());

const me = (token: string) => call(h, 'GET', '/auth/me', { token });
const refresh = (raw: string) => call(h, 'POST', '/auth/refresh', { cookie: `fp_refresh=${raw}` });

describe('FP-008: сессии — отзыв и срок действия', () => {
  it('access-токен короткий (15 минут) и привязан к сессии; refresh-токен в БД только хэшем', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, orgId);
    const { token, refresh: raw } = await login(h, u.email);
    const p = h.app.get(JwtService).decode(token) as any;
    expect(p.exp - p.iat).toBe(15 * 60);
    expect(p.sid).toBeTruthy();
    expect((await me(token)).status).toBe(200);
    const stored = await h.prisma.refreshToken.findMany({ where: { userId: u.id } });
    expect(stored.map((r) => r.token)).toEqual([hashTokenForTest(raw!)]);
    expect(stored[0].token).not.toBe(raw);
  });

  it('выход отзывает сессию: тот же access-токен сразу получает 401, refresh не работает', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, orgId);
    const { token, refresh: raw } = await login(h, u.email);
    expect((await call(h, 'POST', '/auth/logout', { cookie: `fp_refresh=${raw}` })).status).toBe(201);
    expect((await me(token)).status).toBe(401);
    expect((await refresh(raw!)).status).toBe(401);
  });

  it('ротация refresh-токена; повтор старого — признак кражи: отзывается вся сессия', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, orgId);
    const { refresh: raw1 } = await login(h, u.email);
    const r2 = await refresh(raw1!);
    expect(r2.status).toBe(201);
    const raw2 = r2.cookie('fp_refresh')!;
    expect(raw2).not.toBe(raw1);
    expect((await me(r2.body.accessToken)).status).toBe(200);

    expect((await refresh(raw1!)).status).toBe(401); // украденный старый токен
    expect((await me(r2.body.accessToken)).status).toBe(401); // сессия закрыта целиком
    expect((await refresh(raw2)).status).toBe(401);
    expect((await h.prisma.authSession.findFirstOrThrow({ where: { userId: u.id } })).revokedReason).toBe('REFRESH_REUSE');
  });

  it('истёкший access-токен и истёкшая сессия — 401', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, orgId);
    const { token, refresh: raw } = await login(h, u.email);
    const jwt = h.app.get(JwtService);
    const p = jwt.decode(token) as any;
    const expired = jwt.sign({ sub: p.sub, sid: p.sid, email: p.email }, { expiresIn: -60 }); // истёк минуту назад
    expect((await me(expired)).status).toBe(401);

    await h.prisma.authSession.update({ where: { id: p.sid }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await me(token)).status).toBe(401);
    expect((await refresh(raw!)).status).toBe(401);
  });

  it('смена пароля и отключение пользователя закрывают все его сессии', async () => {
    const admin = await makeUser(h, DEFAULT_TENANT, orgId, { name: 'Админ' });
    const u = await makeUser(h, DEFAULT_TENANT, orgId);
    const adminToken = (await login(h, admin.email)).token;
    const t1 = (await login(h, u.email)).token;
    const t2 = (await login(h, u.email)).token;
    expect((await call(h, 'PUT', `/users/${u.id}`, { token: adminToken, body: { password: 'новый-пароль-1' } })).status).toBe(200);
    expect([(await me(t1)).status, (await me(t2)).status]).toEqual([401, 401]);

    const t3 = (await login(h, u.email, 'новый-пароль-1')).token;
    expect((await me(t3)).status).toBe(200);
    expect((await call(h, 'DELETE', `/users/${u.id}`, { token: adminToken })).status).toBe(200);
    expect((await me(t3)).status).toBe(401);
  });

  it('свои сессии: список, завершение одной и «выйти на остальных»; чужую сессию завершить нельзя', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, orgId);
    const other = await makeUser(h, DEFAULT_TENANT, orgId);
    const a = (await login(h, u.email)).token;
    const b = (await login(h, u.email)).token;
    const c = (await login(h, u.email)).token;
    const list = (await call(h, 'GET', '/auth/sessions', { token: a })).body;
    expect(list).toHaveLength(3);
    expect(list.filter((s: any) => s.current)).toHaveLength(1);

    const sidB = (h.app.get(JwtService).decode(b) as any).sid;
    const otherToken = (await login(h, other.email)).token;
    expect((await call(h, 'DELETE', `/auth/sessions/${sidB}`, { token: otherToken })).status).toBe(404);
    expect((await me(b)).status).toBe(200);
    expect((await call(h, 'DELETE', `/auth/sessions/${sidB}`, { token: a })).status).toBe(200);
    expect((await me(b)).status).toBe(401);

    expect((await call(h, 'POST', '/auth/sessions/revoke-others', { token: a })).body.revoked).toBe(1);
    expect([(await me(a)).status, (await me(c)).status]).toEqual([200, 401]);
  });

  it('токен, выданный до сессий (без sid), — 401', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, orgId);
    const legacy = h.app.get(JwtService).sign({ sub: u.id, email: u.email, organizationId: orgId, roles: [] });
    expect((await me(legacy)).status).toBe(401);
  });
});
