import { redact, redactValue } from './redact';
import { RedactingLogger } from './redacting-logger';
import { runWithTrace } from './db-context';

// Значения «как настоящие» по форме; все — выдуманные.
const SIG = 'MEUCIQ' + 'A'.repeat(160) + '==';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE' + 'B'.repeat(80) + '\n-----END CERTIFICATE-----';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl';

describe('FP-022: redact', () => {
  it.each([
    ['PEM-сертификат', `cert ${PEM} end`, ['MIIDdzCCAl']],
    ['XMLDSig тикета', '<ds:SignatureValue>QUJDREVGRw==</ds:SignatureValue><ds:X509Certificate>MIIBxyz</ds:X509Certificate>', ['QUJDREVGRw==', 'MIIBxyz']],
    ['JWT', `token is ${JWT}`, [JWT]],
    ['Bearer', 'Authorization: Bearer abcdef0123456789', ['abcdef0123456789']],
    ['пароль в адресе БД', 'connect postgresql://flowpos_app:S3cr3t-pw@db:5432/flowpos failed', ['S3cr3t-pw']],
    ['sessionId в SOAP', '<esf:sessionId>9f8e7d6c-sess</esf:sessionId>', ['9f8e7d6c-sess']],
    ['поля в JSON (ошибка Prisma с аргументами)', '{"signature":"xyz-sig","certificate":"abc-cert","sessionId":"S-77"}', ['xyz-sig', 'abc-cert', 'S-77']],
    ['ключ=значение', 'refreshToken=r1r2r3 password=hunter2', ['r1r2r3', 'hunter2']],
    ['переменные окружения', 'JWT_SECRET=supersecretvalue MFA_SECRET_KEY=k123', ['supersecretvalue', 'k123']],
    ['длинная «сырая» подпись', `signed: ${SIG}`, [SIG]],
  ])('%s — значение скрыто', (_n, input, secrets) => {
    const out = redact(input);
    for (const sec of secrets) expect(out).not.toContain(sec);
    expect(out).toContain('[скрыто]');
  });

  it('диагностика сохраняется: коды ошибок и номера ЭСФ не скрываются', () => {
    const msg = 'ESF_SIGNATURE_INVALID: ЭСФ № 000123: подпись не соответствует; ESF_SESSION_CLOSED';
    expect(redact(msg)).toBe(msg);
  });

  it('идемпотентно', () => {
    const once = redact(`x ${PEM} y password=1`);
    expect(redact(once)).toBe(once);
  });

  it('объект: чувствительные ключи целиком, вложенные строки — по форме', () => {
    const v = redactValue({ message: `Bearer abcdefgh12345678`, nested: { signingToken: 't', items: [{ certificate: 'c' }] }, count: 3 });
    expect(v).toEqual({ message: 'Bearer [скрыто]', nested: { signingToken: '[скрыто]', items: [{ certificate: '[скрыто]' }] }, count: 3 });
  });
});

describe('FP-022: RedactingLogger', () => {
  it('маскирует сообщение и стек, добавляет код трассировки', async () => {
    const out: string[] = [];
    const spyOut = jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => (out.push(String(s)), true));
    const spyErr = jest.spyOn(process.stderr, 'write').mockImplementation((s: any) => (out.push(String(s)), true));
    try {
      const log = new RedactingLogger('T');
      await runWithTrace('trace-abc-123', () => {
        log.warn(`сессия sessionId=S-SECRET-1 упала`);
        const e = new Error(`password=hunter2 в ${PEM}`);
        log.error(e.message, `Error: password=hunter2\n    at x (${JWT})`);
      });
    } finally {
      spyOut.mockRestore();
      spyErr.mockRestore();
    }
    const all = out.join('');
    expect(all).toContain('[trace trace-abc-123]');
    for (const sec of ['S-SECRET-1', 'hunter2', 'MIIDdzCCAl', JWT]) expect(all).not.toContain(sec);
  });
});
