// Тестовые сертификаты «как у НУЦ РК» (serialNumber=IIN…, OU=BIN…). Только для тестов: ключи живут
// во временной папке и удаляются в cleanup(). Это не сертификаты НУЦ и не юридическая подпись.
import { execFileSync } from 'child_process';
import { createPrivateKey, sign as cryptoSign, KeyObject } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type TestCert = { pem: string; key: KeyObject; sign: (bytes: string) => string };

export function makeCertFactory() {
  const dir = mkdtempSync(join(tmpdir(), 'esf-certs-'));
  let n = 0;
  return {
    cert(opts: { iin: string; bin?: string; keyUsage?: string | null; algo?: 'rsa' | 'ec' }): TestCert {
      const id = ++n;
      const keyFile = join(dir, `k${id}.pem`), certFile = join(dir, `c${id}.pem`);
      const subj = `/C=KZ/CN=TEST SIGNER/serialNumber=IIN${opts.iin}${opts.bin ? `/O=TEST ORG/OU=BIN${opts.bin}` : ''}`;
      const newkey = opts.algo === 'ec' ? ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256'] : ['-newkey', 'rsa:2048'];
      const ext = opts.keyUsage === null ? [] : ['-addext', `keyUsage=critical,${opts.keyUsage ?? 'digitalSignature,nonRepudiation'}`];
      execFileSync('openssl', ['req', '-x509', ...newkey, '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '30', '-subj', subj, '-addext', 'basicConstraints=CA:FALSE', ...ext], { stdio: 'pipe' });
      const key = createPrivateKey(readFileSync(keyFile));
      return { pem: readFileSync(certFile, 'utf8'), key, sign: (bytes: string) => cryptoSign('sha256', Buffer.from(bytes, 'utf8'), key).toString('base64') };
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}
