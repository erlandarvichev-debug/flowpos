// FP-008: второй фактор — TOTP (RFC 6238: HMAC-SHA1, шаг 30 с, 6 цифр), совместим с Google Authenticator и др.
// Без внешних зависимостей. Секрет в БД — только зашифрованным (AES-256-GCM), коды восстановления — хэшами.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
/** Допуск расхождения часов: ±1 шаг. */
export const TOTP_WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Неверный символ base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Код TOTP для шага времени (RFC 4226, динамическое усечение). */
export function totpAt(secret: Buffer, step: number, digits = TOTP_DIGITS, algo: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac(algo, secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / TOTP_STEP_S);

/**
 * Проверка кода. Возвращает принятый шаг или null. Шаг не больше уже принятого (lastStep) отвергается —
 * один код нельзя использовать дважды, даже в пределах его 30 секунд.
 */
export function verifyTotp(secret: Buffer, code: string, lastStep: number | null | undefined, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code ?? '')) return null;
  const now = currentStep(nowMs);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = now + d;
    if (lastStep != null && step <= lastStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export const newTotpSecret = () => randomBytes(20); // 160 бит, как рекомендует RFC 4226

export function otpauthUri(secretB32: string, account: string, issuer = 'FlowPOS') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;
}

// ── Хранение секрета ──

/** Ключ шифрования секретов MFA. В production обязателен MFA_SECRET_KEY (≥ 32 символов, проверяется при старте). */
export function mfaKey(): Buffer {
  const env = process.env.MFA_SECRET_KEY;
  if (env && env.length >= 32) return createHash('sha256').update(env, 'utf8').digest();
  if (process.env.NODE_ENV === 'production') throw new Error('MFA_SECRET_KEY не задан или короче 32 символов');
  // Вне production — производный от JWT-секрета ключ: включённая MFA переживает перезапуск dev-сервера.
  return Buffer.from(hkdfSync('sha256', process.env.JWT_SECRET || 'flowpos-secret', 'flowpos-mfa', 'totp-secret-key', 32));
}

export function encryptSecret(secret: Buffer, key = mfaKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(secret), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(blob: string, key = mfaKey()): Buffer {
  const [v, iv, tag, enc] = blob.split('.');
  if (v !== 'v1') throw new Error('Неизвестный формат секрета MFA');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]);
}

// ── Коды восстановления ──

export const RECOVERY_CODES = 8;
const hashRecovery = (code: string) => createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase(), 'utf8').digest('hex');

export function newRecoveryCodes(): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = randomBytes(5).toString('hex'); // 10 hex-символов
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { plain, hashed: plain.map(hashRecovery) };
}

/** Индекс подходящего кода восстановления (одноразового) или -1. */
export function matchRecoveryCode(code: string, hashed: string[]): number {
  if (!code) return -1;
  return hashed.indexOf(hashRecovery(code));
}
