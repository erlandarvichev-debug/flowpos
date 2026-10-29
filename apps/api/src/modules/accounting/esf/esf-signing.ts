// FP-016: подпись ЭСФ — привязка к точным байтам, проверка сертификата и полномочий подписанта.
// Ключи подписи в backend не попадают никогда: сюда приходят только подпись и сертификат.
// Подпись и сертификат целиком не пишутся в журнал и не возвращаются в тексте ошибок.
import { X509Certificate, createHash, createHmac, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'crypto';

export class EsfSigningError extends Error {
  readonly code: string;
  readonly problems: string[];
  constructor(code: string, message: string, problems: string[] = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }
}

export const SIGNING_REQUEST_TTL_MS = 15 * 60_000;
export const sha256Hex = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// ── Запрос на подпись: сервер фиксирует, ЧТО именно и КТО должен подписать ──

export type SigningSubject = { organizationId: string; userId: string; kind: 'INVOICE' | 'ACTION'; subjectId: string };
type TokenPayload = SigningSubject & { bytesSha256: string; expiresAt: number; nonce: string };

let fallbackSecret: Buffer | null = null;

/** Секрет HMAC запросов на подпись. В production обязателен ESF_SIGNING_SECRET (проверяется при старте). */
export function signingSecret(): Buffer {
  const env = process.env.ESF_SIGNING_SECRET;
  if (env && env.length >= 32) return Buffer.from(env, 'utf8');
  if (process.env.NODE_ENV === 'production') throw new EsfSigningError('ESF_SIGNING_NOT_CONFIGURED', 'ESF_SIGNING_SECRET не задан или короче 32 символов');
  // Вне production: случайный секрет процесса. Запросы не переживают перезапуск — это безопасная сторона.
  fallbackSecret ??= randomBytes(32);
  return fallbackSecret;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function issueSigningRequest(secret: Buffer, subject: SigningSubject, bytes: string, now = Date.now()) {
  const payload: TokenPayload = { ...subject, bytesSha256: sha256Hex(Buffer.from(bytes, 'utf8')), expiresAt: now + SIGNING_REQUEST_TTL_MS, nonce: b64url(randomBytes(9)) };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64url(createHmac('sha256', secret).update(body).digest());
  return { token: `${body}.${mac}`, bytesSha256: payload.bytesSha256, expiresAt: new Date(payload.expiresAt) };
}

/**
 * Запрос на подпись выдан этим сервером, этой организации и этому пользователю, не истёк,
 * а подписываемые сейчас байты совпадают с теми, что были выданы на подпись.
 */
export function verifySigningRequest(secret: Buffer, token: unknown, expect: SigningSubject, currentBytes: string, now = Date.now()): { bytesSha256: string } {
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new EsfSigningError('ESF_SIGN_REQUEST_INVALID', 'Нет действительного запроса на подпись — получите данные для подписи заново');
  }
  const [body, mac] = token.split('.');
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new EsfSigningError('ESF_SIGN_REQUEST_INVALID', 'Запрос на подпись не выдан этим сервером — получите данные для подписи заново');
  }
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  if (p.organizationId !== expect.organizationId || p.kind !== expect.kind || p.subjectId !== expect.subjectId) {
    throw new EsfSigningError('ESF_SIGN_REQUEST_INVALID', 'Запрос на подпись относится к другому документу или организации');
  }
  if (p.userId !== expect.userId) {
    throw new EsfSigningError('ESF_SIGN_REQUEST_INVALID', 'Данные на подпись получал другой пользователь — подписывает тот, кто их запросил');
  }
  if (now >= p.expiresAt) throw new EsfSigningError('ESF_SIGN_REQUEST_EXPIRED', 'Запрос на подпись устарел (15 минут) — получите данные для подписи заново');
  const current = sha256Hex(Buffer.from(currentBytes, 'utf8'));
  if (current !== p.bytesSha256) {
    throw new EsfSigningError('ESF_STALE_SIGNATURE', 'Документ изменился после выдачи на подпись — подпись относится к другим байтам, подпишите заново');
  }
  return { bytesSha256: current };
}

// ── Сертификат ──

export type CertificateInfo = {
  serialNumber: string;
  fingerprint256: string;
  iin: string | null;
  bin: string | null;
  validFrom: Date;
  validTo: Date;
  keyUsage: string[] | null; // null — расширения KeyUsage нет
  keyType: string | null; // 'rsa' | 'ec' | … ; null — Node не умеет этот ключ (например ГОСТ)
  der: Buffer;
  cert: X509Certificate;
};

const KEY_USAGE_BITS = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];

/** KeyUsage (2.5.29.15) из DER: Node отдаёт только extended key usage, поэтому разбираем сами. */
function keyUsageFromDer(der: Buffer): string[] | null {
  const oid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]);
  let at = der.indexOf(oid);
  if (at < 0) return null;
  at += oid.length;
  if (der[at] === 0x01 && der[at + 1] === 0x01) at += 3; // critical BOOLEAN
  if (der[at] !== 0x04) return null; // OCTET STRING
  at += 2;
  if (der[at] !== 0x03) return null; // BIT STRING
  const len = der[at + 1];
  const unused = der[at + 2];
  const bytes = der.subarray(at + 3, at + 2 + len);
  const out: string[] = [];
  const totalBits = bytes.length * 8 - unused;
  for (let i = 0; i < Math.min(totalBits, KEY_USAGE_BITS.length); i++) {
    if (bytes[i >> 3] & (0x80 >> (i & 7))) out.push(KEY_USAGE_BITS[i]);
  }
  return out;
}

export function inspectCertificate(input: unknown): CertificateInfo {
  if (typeof input !== 'string' || !input.trim()) throw new EsfSigningError('ESF_CERT', 'Не передан сертификат подписи');
  if (/PRIVATE KEY/i.test(input)) {
    throw new EsfSigningError('ESF_CERT_PRIVATE_KEY', 'Передан закрытый ключ вместо сертификата. Ключ не сохранён и не отправлен — передавайте только сертификат, подпись делается в NCALayer');
  }
  if (input.length > 20_000) throw new EsfSigningError('ESF_CERT', 'Сертификат слишком большой');
  const b64 = input.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(Buffer.from(b64, 'base64'));
  } catch {
    throw new EsfSigningError('ESF_CERT', 'Сертификат не читается (ожидается X.509 в base64/PEM)');
  }
  let keyType: string | null = null;
  try { keyType = cert.publicKey.asymmetricKeyType ?? null; } catch { keyType = null; }
  const subject = cert.subject;
  return {
    serialNumber: cert.serialNumber,
    fingerprint256: cert.fingerprint256,
    iin: /(?:^|\n)\s*serialNumber\s*=\s*IIN(\d{12})\b/i.exec(subject)?.[1] ?? null,
    bin: /(?:^|\n)\s*OU\s*=\s*BIN(\d{12})\b/i.exec(subject)?.[1] ?? null,
    validFrom: new Date(cert.validFrom),
    validTo: new Date(cert.validTo),
    keyUsage: keyUsageFromDer(cert.raw),
    keyType,
    der: cert.raw,
    cert,
  };
}

export type SignerPolicy = { signerIin: string | null | undefined; organizationBin: string | null | undefined; signatureType: string; now?: Date };

/**
 * Сертификат действует на момент подписи, это ключ ПОДПИСИ (nonRepudiation, не AUTH),
 * принадлежит подписанту из настроек ЭСФ, а для подписи от имени компании — выдан на БИН этой организации.
 */
export function checkSigner(c: CertificateInfo, policy: SignerPolicy): string[] {
  const now = policy.now ?? new Date();
  const problems: string[] = [];
  if (now < c.validFrom) problems.push(`сертификат ещё не действует (с ${c.validFrom.toISOString().slice(0, 10)})`);
  if (now > c.validTo) problems.push(`срок сертификата истёк ${c.validTo.toISOString().slice(0, 10)}`);
  if (!c.keyUsage) problems.push('в сертификате нет назначения ключа (KeyUsage) — нельзя убедиться, что это ключ подписи');
  else if (!c.keyUsage.includes('nonRepudiation')) problems.push('это не ключ подписи (нет nonRepudiation) — вероятно, выбран ключ AUTH; для ЭСФ нужен ключ подписи');
  if (!policy.signerIin) problems.push('в настройках ЭСФ не указан ИИН подписанта');
  else if (c.iin !== policy.signerIin) problems.push(`сертификат выдан на ИИН ${c.iin ?? '(не указан)'}, а подписант в настройках — ${policy.signerIin}`);
  if (policy.signatureType === 'COMPANY') {
    if (!policy.organizationBin) problems.push('у организации не указан БИН');
    else if (c.bin !== policy.organizationBin) problems.push(`подпись от имени компании: сертификат выдан на БИН ${c.bin ?? '(не указан)'}, а организация — ${policy.organizationBin}`);
  }
  return problems;
}

export type SignatureVerification = 'VERIFIED' | 'VERIFICATION_PENDING' | 'INVALID';

/**
 * «Сырая» подпись ровно этих байтов (UTF-8). RSA проверяем сами (SHA256withRSA, PKCS#1 v1.5 — как
 * подписывает NCALayer для RSA-ключей; CONTRACT_UNVERIFIED до первого живого теста с ключом НУЦ).
 * Для ключей, которые Node не проверяет (ГОСТ), — VERIFICATION_PENDING: окончательно проверяет ИС ЭСФ.
 */
export function verifyRawSignature(c: CertificateInfo, bytes: string, signatureB64: string): SignatureVerification {
  if (c.keyType !== 'rsa') return 'VERIFICATION_PENDING';
  const sig = Buffer.from(signatureB64, 'base64');
  if (!sig.length) return 'INVALID';
  try {
    return cryptoVerify('sha256', Buffer.from(bytes, 'utf8'), c.cert.publicKey, sig) ? 'VERIFIED' : 'INVALID';
  } catch {
    return 'INVALID';
  }
}

/** Доказательства проверки для журнала: без подписи и без сертификата целиком. */
export function signingEvidence(c: CertificateInfo, verification: SignatureVerification, bytesSha256: string) {
  return {
    certSerial: c.serialNumber,
    certSha256: c.fingerprint256,
    signerIin: c.iin,
    signerBin: c.bin,
    certValidTo: c.validTo.toISOString(),
    keyUsage: c.keyUsage,
    keyType: c.keyType ?? 'unsupported-by-node',
    verification,
    bytesSha256,
  };
}
