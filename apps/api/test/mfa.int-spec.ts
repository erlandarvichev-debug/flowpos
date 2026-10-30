// FP-008: MFA (TOTP) через HTTP — подключение, вход в два шага, повтор кода, перебор, коды восстановления,
// подтверждение сессии для привилегированных операций, отключение.
import { DEFAULT_TENANT, defaultTenant } from './accounting-helpers';
import { HttpApp, PASSWORD, call, login, makeUser, startApp, uid } from './http-app';
import { base32Decode, currentStep, totpAt } from '../src/modules/auth/mfa';

let h: HttpApp;
let org: string;

beforeAll(async () => {
  h = await startApp();
  await defaultTenant(h.prisma);
  org = (await h.prisma.organization.create({ data: { tenantId: DEFAULT_TENANT, name: `MFA ${uid()}` } })).id;
}, 60_000);
afterAll(async () => {
  delete process.env.MFA_ENFORCE;
  await h?.app.close();
});

const code = (secret: string, offset = 0) => totpAt(base32Decode(secret), currentStep() + offset);
/** Сбросить «последний принятый шаг», чтобы получить ещё один действительный код в тесте. */
const allowNextCode = (userId: string) => h.prisma.user.update({ where: { id: userId }, data: { mfaLastStep: null } });

async function userWithMfa(role = 'admin') {
  const u = await makeUser(h, DEFAULT_TENANT, org, { role });
  const { token } = await login(h, u.email);
  const setup = await call(h, 'POST', '/auth/mfa/setup', { token });
  expect(setup.status).toBe(201);
  expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);
  const enable = await call(h, 'POST', '/auth/mfa/enable', { token, body: { code: code(setup.body.secret) } });
  expect(enable.status).toBe(201);
  await allowNextCode(u.id);
  return { ...u, secret: setup.body.secret as string, token, recovery: enable.body.recoveryCodes as string[] };
}

describe('FP-008: MFA', () => {
  it('подключение: неверный код не включает MFA; секрет в БД зашифрован; 8 кодов восстановления', async () => {
    const u = await makeUser(h, DEFAULT_TENANT, org);
    const { token } = await login(h, u.email);
    const { secret } = (await call(h, 'POST', '/auth/mfa/setup', { token })).body;
    expect((await call(h, 'POST', '/auth/mfa/enable', { token, body: { code: '000000' } })).body.code).toBe('MFA_INVALID');
    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.mfaEnabledAt).toBeNull();
    expect(row.mfaSecretEnc).not.toContain(secret);
    const ok = await call(h, 'POST', '/auth/mfa/enable', { token, body: { code: code(secret) } });
    expect(ok.body.recoveryCodes).toHaveLength(8);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mfaRecoveryCodes.some((c) => ok.body.recoveryCodes.includes(c))).toBe(false);
    expect((await call(h, 'POST', '/auth/mfa/setup', { token })).status).toBe(409);
  });

  it('вход в два шага: после пароля — только токен-вызов, он не даёт доступа; код открывает сессию', async () => {
    const u = await userWithMfa();
    const first = await login(h, u.email);
    expect(first.res.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(first.refresh).toBeUndefined();
    expect((await call(h, 'GET', '/auth/me', { token: first.res.body.mfaToken })).status).toBe(401);

    const second = await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken: first.res.body.mfaToken, code: code(u.secret) } });
    expect(second.status).toBe(201);
    expect(second.cookie('fp_refresh')).toBeTruthy();
    expect((await call(h, 'GET', '/auth/me', { token: second.body.accessToken })).status).toBe(200);
    // Тот же код второй раз — нет (повтор перехваченного кода).
    const again = await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken: first.res.body.mfaToken, code: code(u.secret) } });
    expect([again.status, again.body.code]).toEqual([401, 'MFA_INVALID']);
    // Неверный пароль по-прежнему 401 без вызова.
    expect((await login(h, u.email, PASSWORD + 'x')).res.status).toBe(401);
  });

  it('перебор: 5 неверных кодов блокируют второй фактор — даже верный код не проходит', async () => {
    const u = await userWithMfa();
    const { mfaToken } = (await login(h, u.email)).res.body;
    for (let i = 0; i < 5; i++) {
      expect((await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken, code: String(100000 + i) } })).body.code).toBe('MFA_INVALID');
    }
    const locked = await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken, code: code(u.secret) } });
    expect([locked.status, locked.body.code]).toEqual([401, 'MFA_LOCKED']);
  });

  it('код восстановления действует один раз', async () => {
    const u = await userWithMfa();
    const t1 = (await login(h, u.email)).res.body.mfaToken;
    expect((await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken: t1, code: u.recovery[0] } })).status).toBe(201);
    const t2 = (await login(h, u.email)).res.body.mfaToken;
    expect((await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken: t2, code: u.recovery[0] } })).body.code).toBe('MFA_INVALID');
    expect((await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken: t2, code: u.recovery[1] } })).status).toBe(201);
  });

  it('привилегированная операция требует сессию с MFA: без второго фактора — 403 MFA_REQUIRED, после подтверждения — можно', async () => {
    process.env.MFA_ENFORCE = '1';
    try {
      const plain = await makeUser(h, DEFAULT_TENANT, org, { role: 'admin' });
      const tPlain = (await login(h, plain.email)).token;
      const newUser = () => ({ email: `n-${uid()}@example.com`, password: 'пароль-123', firstName: 'Н', lastName: 'Н', role: 'cashier' });
      const denied = await call(h, 'POST', '/users', { token: tPlain, body: newUser() });
      expect([denied.status, denied.body.code]).toEqual([403, 'MFA_REQUIRED']);
      expect((await call(h, 'GET', '/users', { token: tPlain })).status).toBe(200); // чтение — без второго фактора

      const u = await userWithMfa('admin');
      // Сессия, в которой MFA только что включили, уже подтверждена.
      expect((await call(h, 'POST', '/users', { token: u.token, body: newUser() })).status).toBe(201);
      // Вход паролем + кодом — подтверждена; step-up подтверждает и старую сессию.
      const viaMfa = await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken: (await login(h, u.email)).res.body.mfaToken, code: code(u.secret) } });
      expect((await call(h, 'POST', '/users', { token: viaMfa.body.accessToken, body: newUser() })).status).toBe(201);

      // Отключение MFA снимает подтверждение со всех сессий.
      await allowNextCode(u.id);
      expect((await call(h, 'POST', '/auth/mfa/disable', { token: u.token, body: { code: '000000' } })).status).toBe(401);
      await allowNextCode(u.id);
      expect((await call(h, 'POST', '/auth/mfa/disable', { token: u.token, body: { code: code(u.secret) } })).status).toBe(201);
      expect((await call(h, 'POST', '/users', { token: viaMfa.body.accessToken, body: newUser() })).body.code).toBe('MFA_REQUIRED');
      expect((await login(h, u.email)).res.body.mfaRequired).toBe(false);
    } finally {
      delete process.env.MFA_ENFORCE;
    }
  });

  it('step-up: сессия, открытая паролем до включения MFA, подтверждается кодом', async () => {
    process.env.MFA_ENFORCE = '1';
    try {
      const u = await userWithMfa('admin');
      const tAdmin2 = (await call(h, 'POST', '/auth/mfa/login', { body: { mfaToken: (await login(h, u.email)).res.body.mfaToken, code: code(u.secret) } })).body.accessToken;
      // Старая сессия без MFA: сбросить отметку и проверить step-up.
      const sid = JSON.parse(Buffer.from(tAdmin2.split('.')[1], 'base64url').toString()).sid;
      await h.prisma.authSession.update({ where: { id: sid }, data: { mfaAt: null } });
      expect((await call(h, 'POST', '/users/' + u.id + '/revoke-sessions', { token: tAdmin2 })).body.code).toBe('MFA_REQUIRED');
      await allowNextCode(u.id);
      expect((await call(h, 'POST', '/auth/mfa/step-up', { token: tAdmin2, body: { code: code(u.secret) } })).status).toBe(201);
      expect((await h.prisma.authSession.findUniqueOrThrow({ where: { id: sid } })).mfaAt).not.toBeNull();
    } finally {
      delete process.env.MFA_ENFORCE;
    }
  });
});
