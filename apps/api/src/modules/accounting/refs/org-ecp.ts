// Добавление организации через ЭЦП НУЦ РК. Сертификат публичен, поэтому одного сертификата мало: клиент подписывает в
// NCALayer одноразовый код с сервера (CMS без вложенных данных), а подпись, цепочку до НУЦ и отзыв (OCSP) проверяет
// NCANode (RSA и ГОСТ). Организацию юрлица заводит только первый руководитель или сотрудник с правом подписи; ИП — по
// своему ключу физлица. Данные организации (БИН/ИИН, наименование) берутся из проверенного сертификата, не из формы.
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { RefsService } from './refs.service';

export const CHALLENGE_TTL_MS = 5 * 60_000;

/** Сертификат подписанта — как его возвращает NCANode v3 (`/cms/verify` → signers[].certificates[0]). */
export interface EcpCertificate {
  valid?: boolean;
  serialNumber?: string;
  notBefore?: string;
  notAfter?: string;
  keyUsage?: 'AUTH' | 'SIGN' | 'UNKNOWN';
  keyUser?: string[];
  revocations?: { by?: string; revoked?: boolean; reason?: string; revocationTime?: string }[];
  subject?: { iin?: string; bin?: string; organization?: string; commonName?: string; surName?: string; lastName?: string };
  signAlg?: string;
}
export interface EcpVerification {
  valid: boolean;
  message?: string;
  signers: { status?: string; subIndication?: string; certificates: EcpCertificate[] }[];
}
export interface EcpVerifier {
  verifyCms(cms: string, dataB64: string): Promise<EcpVerification>;
}

/** NCANode v3 на этом же сервере (NCANODE_URL, например http://127.0.0.1:14579). */
export class NcaNodeVerifier implements EcpVerifier {
  constructor(private url: string, private timeoutMs = 20_000) {}
  async verifyCms(cms: string, dataB64: string): Promise<EcpVerification> {
    let res: Response;
    try {
      res = await fetch(`${this.url.replace(/\/$/, '')}/cms/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cms, data: dataB64, revocationCheck: ['OCSP'] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AccError('ECP_VERIFIER_UNAVAILABLE', 'Служба проверки ЭЦП не отвечает — повторите позже', { status: 503 });
    }
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body) throw new AccError('ECP_VERIFIER_UNAVAILABLE', `Служба проверки ЭЦП вернула ошибку ${res.status}`, { status: 503 });
    return { valid: !!body.valid, message: body.message, signers: Array.isArray(body.signers) ? body.signers : [] };
  }
}

const LEGAL_FORMS: [RegExp, string][] = [
  [/^\s*(ТОО|ЖШС|Товарищество с ограниченной ответственностью)(?![а-яё])/i, 'TOO'],
  [/^\s*(АО|АҚ|Акционерное общество)(?![а-яё])/i, 'AO'],
  [/^\s*(ИП|Индивидуальный предприниматель)(?![а-яё])/i, 'IP'],
];
const legalFormOf = (name: string) => LEGAL_FORMS.find(([re]) => re.test(name))?.[1] ?? 'OTHER';
const clean = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Что разрешает сертификат: организация из него или список причин отказа. */
export function checkEcpSigner(v: EcpVerification, now = new Date()): { problems: string[]; cert?: EcpCertificate; org?: { name: string; inn: string; legalForm: string } } {
  const signer = v.signers[0];
  const cert = signer?.certificates?.[0];
  if (!cert) return { problems: [v.message || 'подпись не прочитана'] };
  const problems: string[] = [];
  if (v.signers.length !== 1) problems.push('ожидается одна подпись');
  if (!v.valid || (signer.status && signer.status !== 'VALID')) problems.push(`подпись не прошла проверку${signer.subIndication ? ` (${signer.subIndication})` : v.message ? ` (${v.message})` : ''}`);
  if (cert.valid === false) problems.push('сертификат недействителен (цепочка до НУЦ РК не подтверждена)');
  if (cert.notBefore && now < new Date(cert.notBefore)) problems.push('сертификат ещё не действует');
  if (cert.notAfter && now > new Date(cert.notAfter)) problems.push(`срок сертификата истёк ${cert.notAfter.slice(0, 10)}`);
  const revs = cert.revocations ?? [];
  if (!revs.length) problems.push('статус отзыва сертификата не получен (OCSP)');
  if (revs.some((r) => r.revoked)) problems.push('сертификат отозван');
  const s = cert.subject ?? {};
  const users = new Set(cert.keyUser ?? []);
  const bin = /^\d{12}$/.test(s.bin ?? '') ? s.bin! : null;
  const iin = /^\d{12}$/.test(s.iin ?? '') ? s.iin! : null;
  let org: { name: string; inn: string; legalForm: string } | undefined;
  if (bin) {
    if (!users.has('CEO') && !users.has('CAN_SIGN')) problems.push('ключ сотрудника без права подписи — организацию заводит первый руководитель или сотрудник с правом подписи');
    const name = clean(s.organization);
    if (!name) problems.push('в сертификате нет наименования организации');
    org = { name, inn: bin, legalForm: legalFormOf(name) };
  } else if (iin) {
    // НУЦ: CN — «ФАМИЛИЯ ИМЯ», отчество — отдельно (NCANode: lastName).
    const person = clean(`${s.commonName ?? ''} ${s.lastName ?? ''}`);
    org = { name: `ИП ${person}`.trim(), inn: iin, legalForm: 'IP' };
  } else problems.push('в сертификате нет ни БИН, ни ИИН');
  return { problems, cert, org: problems.length ? undefined : org };
}

@Injectable()
export class OrgEcpService {
  /** Подменяется в тестах; в работе — NCANode по NCANODE_URL. */
  verifier: EcpVerifier | null = process.env.NCANODE_URL ? new NcaNodeVerifier(process.env.NCANODE_URL) : null;
  private challenges = new Map<string, { userId: string; challenge: string; expiresAt: number }>();

  constructor(private prisma: PrismaService, private refs: RefsService) {}

  /** Одноразовый код для подписи (5 минут, только этому пользователю). */
  challenge(userId: string, now = Date.now()) {
    if (!this.verifier) throw new AccError('ECP_VERIFIER_NOT_CONFIGURED', 'Проверка ЭЦП на сервере не настроена — создайте организацию вручную или обратитесь к администратору', { status: 503 });
    for (const [k, c] of this.challenges) if (c.expiresAt <= now) this.challenges.delete(k);
    // Не больше 5 действующих кодов на пользователя (старые отбрасываются) и 10 000 всего — память не раздуть.
    const mine = [...this.challenges].filter(([, c]) => c.userId === userId);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - 4))) this.challenges.delete(k);
    if (this.challenges.size >= 10_000) throw new AccError('ECP_BUSY', 'Слишком много незавершённых подписей — повторите через несколько минут', { status: 429 });
    const id = randomBytes(16).toString('hex');
    const challenge = `FlowPOS: добавление организации. Код ${randomBytes(24).toString('base64url')}. ${new Date(now).toISOString()}`;
    this.challenges.set(id, { userId, challenge, expiresAt: now + CHALLENGE_TTL_MS });
    return { challengeId: id, data: Buffer.from(challenge, 'utf8').toString('base64'), expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString() };
  }

  async create(userId: string, input: { challengeId?: string; cms?: string; vatPayer?: boolean; taxRegime?: string; nameKk?: string }, now = Date.now()) {
    if (!this.verifier) throw new AccError('ECP_VERIFIER_NOT_CONFIGURED', 'Проверка ЭЦП на сервере не настроена', { status: 503 });
    const c = input.challengeId ? this.challenges.get(input.challengeId) : undefined;
    if (!c || c.userId !== userId) throw new AccError('ECP_CHALLENGE_INVALID', 'Код для подписи не найден или выдан другому пользователю — начните заново');
    this.challenges.delete(input.challengeId!); // одноразовый: и при успехе, и при отказе
    if (c.expiresAt <= now) throw new AccError('ECP_CHALLENGE_EXPIRED', 'Код для подписи устарел (5 минут) — начните заново');
    if (typeof input.cms !== 'string' || !input.cms.trim() || input.cms.length > 50_000) throw new AccError('ECP_SIGNATURE_REQUIRED', 'Не передана подпись');
    if (/PRIVATE KEY/i.test(input.cms)) throw new AccError('ECP_SIGNATURE_REQUIRED', 'Передан закрытый ключ вместо подписи — он не сохранён; подписывайте в NCALayer');

    const v = await this.verifier.verifyCms(input.cms.trim(), Buffer.from(c.challenge, 'utf8').toString('base64'));
    const { problems, cert, org } = checkEcpSigner(v, new Date(now));
    const evidence = {
      certSerial: cert?.serialNumber ?? null, signerIin: cert?.subject?.iin ?? null, bin: cert?.subject?.bin ?? null,
      keyUser: cert?.keyUser ?? [], keyUsage: cert?.keyUsage ?? null, certValidTo: cert?.notAfter ?? null, signAlg: cert?.signAlg ?? null,
      ocsp: (cert?.revocations ?? []).map((r) => ({ by: r.by, revoked: !!r.revoked })),
      challengeSha256: createHash('sha256').update(c.challenge).digest('hex'),
    };
    if (problems.length || !org) {
      await this.prisma.auditLog.create({ data: { userId, action: 'ORG_ECP_REJECTED', entity: 'Organization', reason: problems.join('; ').slice(0, 1000), after: evidence as any } });
      throw new AccError('ECP_REJECTED', `ЭЦП не принята: ${problems.join('; ')}`, { status: 422 });
    }
    const creator = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
    const same = await this.prisma.organization.findFirst({ where: { tenantId: creator.tenantId, inn: org.inn, isActive: true }, select: { name: true } });
    if (same) throw new AccError('ORG_EXISTS', `Организация с БИН/ИИН ${org.inn} уже есть: ${same.name}`, { status: 409, fix: 'Попросите её владельца добавить вас в сотрудники организации.' });

    const created = await this.refs.createOrganization(userId, { name: org.name, inn: org.inn, legalForm: org.legalForm, nameKk: input.nameKk, vatPayer: input.vatPayer, taxRegime: input.taxRegime });
    await this.prisma.auditLog.create({ data: { userId, organizationId: created.id, action: 'ORG_CREATE_ECP', entity: 'Organization', entityId: created.id, after: evidence as any } });
    return created;
  }
}
