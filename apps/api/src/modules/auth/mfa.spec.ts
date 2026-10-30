import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, matchRecoveryCode, newRecoveryCodes, newTotpSecret,
  otpauthUri, totpAt, verifyTotp,
} from './mfa';

// RFC 6238, приложение B: секрет "12345678901234567890" (SHA1), 8 цифр.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('FP-008: TOTP', () => {
  it.each(RFC_VECTORS)('эталонный вектор RFC 6238 для T=%i', (t, code) => {
    expect(totpAt(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
  });

  it('base32 туда и обратно; эталон RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const s = newTotpSecret();
    expect(base32Decode(base32Encode(s)).equals(s)).toBe(true);
  });

  it('код принимается в окне ±30 с, не за его пределами; повтор того же шага — нет', () => {
    const s = newTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(s, totpAt(s, step), null, now)).toBe(step);
    expect(verifyTotp(s, totpAt(s, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(s, totpAt(s, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(s, totpAt(s, step - 2), null, now)).toBeNull();
    expect(verifyTotp(s, totpAt(s, step), step, now)).toBeNull(); // уже использован
    expect(verifyTotp(s, totpAt(s, step - 1), step, now)).toBeNull(); // старее принятого
    expect(verifyTotp(s, '12345', null, now)).toBeNull();
    expect(verifyTotp(s, 'abcdef', null, now)).toBeNull();
  });

  it('секрет шифруется (AES-256-GCM): другой ключ или подмена — ошибка', () => {
    const key = Buffer.alloc(32, 7);
    const s = newTotpSecret();
    const blob = encryptSecret(s, key);
    expect(blob).not.toContain(base32Encode(s));
    expect(decryptSecret(blob, key).equals(s)).toBe(true);
    expect(() => decryptSecret(blob, Buffer.alloc(32, 8))).toThrow();
    const parts = blob.split('.');
    parts[3] = Buffer.from('подмена').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('коды восстановления одноразовые и хранятся хэшами', () => {
    const { plain, hashed } = newRecoveryCodes();
    expect(plain).toHaveLength(8);
    expect(hashed.some((h) => plain.includes(h))).toBe(false);
    expect(matchRecoveryCode(plain[3].toUpperCase(), hashed)).toBe(3);
    expect(matchRecoveryCode('00000-00000', hashed)).toBe(-1);
  });

  it('otpauth-ссылка для приложения-аутентификатора', () => {
    expect(otpauthUri('JBSWY3DPEHPK3PXP', 'user@example.com')).toBe(
      'otpauth://totp/FlowPOS%3Auser%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=FlowPOS&algorithm=SHA1&digits=6&period=30',
    );
  });
});
