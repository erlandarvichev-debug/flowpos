// FP-016 acceptance: exact bytes hash; сертификат/назначение/полномочия/expiry; stale approval блокируется; нет key в логах.
import { randomBytes } from 'crypto';
import { makeCertFactory } from '../../../../test/esf-certs';
import {
  EsfSigningError, SIGNING_REQUEST_TTL_MS, checkSigner, inspectCertificate, issueSigningRequest, sha256Hex,
  signingEvidence, signingSecret, verifyRawSignature, verifySigningRequest,
} from './esf-signing';

const IIN = '123456789012';
const BIN = '123456789021';
const certs = makeCertFactory();
afterAll(() => certs.cleanup());

const signer = certs.cert({ iin: IIN, bin: BIN });
const authKey = certs.cert({ iin: IIN, bin: BIN, keyUsage: 'digitalSignature,keyEncipherment' });
const noKeyUsage = certs.cert({ iin: IIN, bin: BIN, keyUsage: null });
const otherPerson = certs.cert({ iin: '999999999999', bin: BIN });
const otherCompany = certs.cert({ iin: IIN, bin: '888888888888' });
const individual = certs.cert({ iin: IIN });
const ecKey = certs.cert({ iin: IIN, bin: BIN, algo: 'ec' });

const BODY = '<v2:invoice xmlns:v2="v2.esf"><num>1</num><description>Товар &amp; «услуга»</description></v2:invoice>';
const subject = { organizationId: 'org-1', userId: 'user-1', kind: 'INVOICE' as const, subjectId: 'inv-1' };
const secret = randomBytes(32);

const code = (fn: () => unknown) => {
  try { fn(); } catch (e: any) { return e.code; }
  return 'NO_ERROR';
};

describe('FP-016: подпись привязана к точным байтам; устаревшее подтверждение блокируется', () => {
  it('запрос на подпись принимается для тех же байтов, того же пользователя, документа и организации', () => {
    const req = issueSigningRequest(secret, subject, BODY);
    expect(req.bytesSha256).toBe(sha256Hex(Buffer.from(BODY, 'utf8')));
    expect(verifySigningRequest(secret, req.token, subject, BODY)).toEqual({ bytesSha256: req.bytesSha256 });
  });

  it('один изменённый байт — подпись устарела', () => {
    const req = issueSigningRequest(secret, subject, BODY);
    expect(code(() => verifySigningRequest(secret, req.token, subject, BODY.replace('<num>1</num>', '<num>2</num>')))).toBe('ESF_STALE_SIGNATURE');
    expect(code(() => verifySigningRequest(secret, req.token, subject, BODY + ' '))).toBe('ESF_STALE_SIGNATURE');
  });

  it('истёкший запрос — отказ, на границе срока тоже', () => {
    const now = Date.now();
    const req = issueSigningRequest(secret, subject, BODY, now);
    expect(code(() => verifySigningRequest(secret, req.token, subject, BODY, now + SIGNING_REQUEST_TTL_MS - 1))).toBe('NO_ERROR');
    expect(code(() => verifySigningRequest(secret, req.token, subject, BODY, now + SIGNING_REQUEST_TTL_MS))).toBe('ESF_SIGN_REQUEST_EXPIRED');
  });

  it('чужой пользователь, документ, вид операции или организация — отказ', () => {
    const { token } = issueSigningRequest(secret, subject, BODY);
    for (const other of [{ userId: 'user-2' }, { subjectId: 'inv-2' }, { kind: 'ACTION' as const }, { organizationId: 'org-2' }]) {
      expect(code(() => verifySigningRequest(secret, token, { ...subject, ...other }, BODY))).toBe('ESF_SIGN_REQUEST_INVALID');
    }
  });

  it('подделанный, чужой или отсутствующий запрос — отказ', () => {
    const { token } = issueSigningRequest(secret, subject, BODY);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), expiresAt: Date.now() + 1e9 })).toString('base64url');
    expect(code(() => verifySigningRequest(secret, `${forged}.${mac}`, subject, BODY))).toBe('ESF_SIGN_REQUEST_INVALID');
    expect(code(() => verifySigningRequest(randomBytes(32), token, subject, BODY))).toBe('ESF_SIGN_REQUEST_INVALID');
    expect(code(() => verifySigningRequest(secret, undefined, subject, BODY))).toBe('ESF_SIGN_REQUEST_INVALID');
    expect(code(() => verifySigningRequest(secret, 'x.y.z', subject, BODY))).toBe('ESF_SIGN_REQUEST_INVALID');
  });

  it('в production без ESF_SIGNING_SECRET (или с коротким) подпись не работает', () => {
    const env = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ESF_SIGNING_SECRET;
      expect(code(() => signingSecret())).toBe('ESF_SIGNING_NOT_CONFIGURED');
      process.env.ESF_SIGNING_SECRET = 'short';
      expect(code(() => signingSecret())).toBe('ESF_SIGNING_NOT_CONFIGURED');
      process.env.ESF_SIGNING_SECRET = 'x'.repeat(32);
      expect(signingSecret().length).toBe(32);
    } finally {
      process.env = env;
    }
  });
});

describe('FP-016: криптографическая проверка подписи над точными байтами', () => {
  const c = inspectCertificate(signer.pem);

  it('RSA-подпись ровно этих байтов — VERIFIED', () => {
    expect(verifyRawSignature(c, BODY, signer.sign(BODY))).toBe('VERIFIED');
  });

  it('подпись других байтов, другим ключом или мусор — INVALID', () => {
    expect(verifyRawSignature(c, BODY, signer.sign(BODY + ' '))).toBe('INVALID');
    expect(verifyRawSignature(c, BODY, otherPerson.sign(BODY))).toBe('INVALID');
    expect(verifyRawSignature(c, BODY, '')).toBe('INVALID');
    expect(verifyRawSignature(c, BODY, 'c2ln')).toBe('INVALID');
  });

  it('ключ, который backend не проверяет сам (не RSA, например ГОСТ), — VERIFICATION_PENDING, а не VERIFIED', () => {
    const ec = inspectCertificate(ecKey.pem);
    expect(ec.keyType).toBe('ec');
    expect(verifyRawSignature(ec, BODY, ecKey.sign(BODY))).toBe('VERIFICATION_PENDING');
  });
});

describe('FP-016: сертификат — назначение, срок, принадлежность и полномочия', () => {
  const policy = { signerIin: IIN, organizationBin: BIN, signatureType: 'COMPANY' };

  it('читает PEM и голый base64; ИИН, БИН и KeyUsage', () => {
    const c = inspectCertificate(signer.pem);
    const bare = inspectCertificate(signer.pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    expect(bare.fingerprint256).toBe(c.fingerprint256);
    expect([c.iin, c.bin, c.keyType]).toEqual([IIN, BIN, 'rsa']);
    expect(c.keyUsage).toEqual(['digitalSignature', 'nonRepudiation']);
    expect(inspectCertificate(authKey.pem).keyUsage).toEqual(['digitalSignature', 'keyEncipherment']);
    expect(inspectCertificate(noKeyUsage.pem).keyUsage).toBeNull();
  });

  it('подходящий ключ подписи этой организации — без замечаний', () => {
    expect(checkSigner(inspectCertificate(signer.pem), policy)).toEqual([]);
  });

  it('ключ AUTH (без nonRepudiation) и ключ без KeyUsage не годятся для подписи ЭСФ', () => {
    expect(checkSigner(inspectCertificate(authKey.pem), policy).join()).toMatch(/не ключ подписи.*AUTH/);
    expect(checkSigner(inspectCertificate(noKeyUsage.pem), policy).join()).toMatch(/нет назначения ключа/);
  });

  it('просроченный и ещё не действующий сертификат', () => {
    const c = inspectCertificate(signer.pem);
    expect(checkSigner(c, { ...policy, now: new Date(c.validTo.getTime() + 1000) }).join()).toMatch(/срок сертификата истёк/);
    expect(checkSigner(c, { ...policy, now: new Date(c.validFrom.getTime() - 1000) }).join()).toMatch(/ещё не действует/);
  });

  it('чужой ИИН и чужой БИН — нет полномочий', () => {
    expect(checkSigner(inspectCertificate(otherPerson.pem), policy).join()).toMatch(/ИИН 999999999999.*в настройках — 123456789012/);
    expect(checkSigner(inspectCertificate(otherCompany.pem), policy).join()).toMatch(/БИН 888888888888.*организация — 123456789021/);
    expect(checkSigner(inspectCertificate(individual.pem), policy).join()).toMatch(/БИН \(не указан\)/);
    expect(checkSigner(inspectCertificate(signer.pem), { ...policy, signerIin: null }).join()).toMatch(/не указан ИИН подписанта/);
  });

  it('подпись оператора (OPERATOR) не требует БИН в сертификате, но требует ИИН', () => {
    expect(checkSigner(inspectCertificate(individual.pem), { ...policy, signatureType: 'OPERATOR' })).toEqual([]);
  });

  it('мусор вместо сертификата — понятная ошибка', () => {
    expect(code(() => inspectCertificate('MIIC'))).toBe('ESF_CERT');
    expect(code(() => inspectCertificate(''))).toBe('ESF_CERT');
  });
});

describe('FP-016: ключ не попадает в backend, журнал и тексты ошибок', () => {
  it('закрытый ключ вместо сертификата — отказ, и ни байта ключа в ошибке', () => {
    const keyPem = signer.key.export({ type: 'pkcs8', format: 'pem' }).toString();
    const keyBody = keyPem.split('\n')[1];
    let err: EsfSigningError | undefined;
    try { inspectCertificate(keyPem); } catch (e: any) { err = e; }
    expect(err?.code).toBe('ESF_CERT_PRIVATE_KEY');
    const everything = JSON.stringify({ message: err!.message, problems: err!.problems, stack: err!.stack });
    expect(everything).not.toContain(keyBody.slice(0, 16));
    expect(code(() => inspectCertificate(`${signer.pem}\n${keyPem}`))).toBe('ESF_CERT_PRIVATE_KEY');
  });

  it('доказательства для журнала не содержат ни подписи, ни сертификата целиком', () => {
    const c = inspectCertificate(signer.pem);
    const sig = signer.sign(BODY);
    const ev = signingEvidence(c, verifyRawSignature(c, BODY, sig), sha256Hex(BODY));
    const text = JSON.stringify(ev);
    expect(text).not.toContain(sig.slice(0, 24));
    expect(text).not.toContain(signer.pem.split('\n')[2]);
    expect(ev).toMatchObject({ signerIin: IIN, signerBin: BIN, verification: 'VERIFIED', keyType: 'rsa' });
  });
});
