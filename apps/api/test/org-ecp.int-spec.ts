// Добавление организации через ЭЦП: одноразовый код, проверка подписи (NCANode — заглушка), роль владельца ключа,
// данные организации только из сертификата, журнал аудита.
import { PrismaService } from '../src/prisma/prisma.service';
import { RefsService } from '../src/modules/accounting/refs/refs.service';
import { OrgEcpService, EcpVerification, EcpCertificate, checkEcpSigner } from '../src/modules/accounting/refs/org-ecp';
import { makeOrg } from './accounting-helpers';

const prisma = new PrismaService();
const svc = new OrgEcpService(prisma, new RefsService(prisma));
const created: string[] = [];
const bin = () => String(100000000000 + Math.floor(Math.random() * 899999999999)).slice(0, 12);

async function code(p: Promise<unknown>) {
  try { await p; return 'OK'; } catch (e: any) { return e?.getResponse?.()?.code ?? e?.code ?? e?.message; }
}
const cert = (over: Partial<EcpCertificate> = {}, subject: EcpCertificate['subject'] = {}): EcpCertificate => ({
  valid: true, serialNumber: 'ab12', notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z', keyUsage: 'AUTH',
  keyUser: ['ORGANIZATION', 'CEO'], revocations: [{ by: 'OCSP', revoked: false }], signAlg: 'ECGOST3410-2015-512',
  subject: { iin: '880101300123', bin: '201240000123', organization: 'ТОО "Ромашка"', commonName: 'ИВАНОВ ИВАН', lastName: 'ИВАНОВИЧ', ...subject }, ...over,
});
/** Заглушка NCANode: запоминает, что пришло на проверку, отвечает заданным результатом. */
function stub(result: (cms: string, data: string) => EcpVerification) {
  const calls: { cms: string; data: string }[] = [];
  svc.verifier = { verifyCms: async (cms, data) => { calls.push({ cms, data }); return result(cms, data); } };
  return calls;
}
const ok = (c: EcpCertificate): EcpVerification => ({ valid: true, signers: [{ status: 'VALID', certificates: [c] }] });

afterAll(async () => {
  await prisma.accPolicy.deleteMany({ where: { organizationId: { in: created } } });
  await prisma.orgMembership.deleteMany({ where: { organizationId: { in: created } } });
  await prisma.organization.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe('Организация по ЭЦП', () => {
  it('без настроенной проверки — отказ; код одноразовый, только своему пользователю и 5 минут', async () => {
    const ctx = await makeOrg(prisma);
    svc.verifier = null;
    expect(await code(Promise.resolve().then(() => svc.challenge(ctx.userId)))).toBe('ECP_VERIFIER_NOT_CONFIGURED');
    stub(() => ok(cert({}, { bin: bin() })));
    const other = await makeOrg(prisma);
    const c1 = svc.challenge(ctx.userId);
    expect(Buffer.from(c1.data, 'base64').toString('utf8')).toMatch(/^FlowPOS: добавление организации\. Код /);
    expect(await code(svc.create(other.userId, { challengeId: c1.challengeId, cms: 'MII' }))).toBe('ECP_CHALLENGE_INVALID');
    // Чужая попытка код не сжигает (иначе можно сорвать чужую подпись); свой — срабатывает один раз.
    const org = await svc.create(ctx.userId, { challengeId: c1.challengeId, cms: 'MII' });
    created.push(org.id);
    expect(await code(svc.create(ctx.userId, { challengeId: c1.challengeId, cms: 'MII' }))).toBe('ECP_CHALLENGE_INVALID');
    const c2 = svc.challenge(ctx.userId, Date.now() - 6 * 60_000);
    expect(await code(svc.create(ctx.userId, { challengeId: c2.challengeId, cms: 'MII' }))).toBe('ECP_CHALLENGE_EXPIRED');
    const c3 = svc.challenge(ctx.userId);
    expect(await code(svc.create(ctx.userId, { challengeId: c3.challengeId, cms: '' }))).toBe('ECP_SIGNATURE_REQUIRED');
  });

  it('руководитель: организация из сертификата (наименование, БИН, форма), владелец — подписавший, подпись — над выданным кодом; аудит', async () => {
    const ctx = await makeOrg(prisma);
    const b = bin();
    const calls = stub(() => ok(cert({}, { bin: b })));
    const ch = svc.challenge(ctx.userId);
    const org = await svc.create(ctx.userId, { challengeId: ch.challengeId, cms: 'MIIcms', vatPayer: true, name: 'Подмена', inn: '999999999999' } as any);
    created.push(org.id);
    expect([org.name, org.inn, org.legalForm]).toEqual(['ТОО "Ромашка"', b, 'TOO']);
    expect(calls).toEqual([{ cms: 'MIIcms', data: ch.data }]);
    expect((await prisma.orgMembership.findFirstOrThrow({ where: { organizationId: org.id } })).role).toBe('owner');
    expect((await prisma.accPolicy.findFirstOrThrow({ where: { organizationId: org.id } })).vatPayer).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, action: 'ORG_CREATE_ECP' } });
    expect(audit.after).toMatchObject({ bin: b, signerIin: '880101300123', keyUser: ['ORGANIZATION', 'CEO'], ocsp: [{ by: 'OCSP', revoked: false }] });
    expect(JSON.stringify(audit.after)).not.toContain('MIIcms');
    // Та же организация второй раз — нельзя.
    const again = svc.challenge(ctx.userId);
    expect(await code(svc.create(ctx.userId, { challengeId: again.challengeId, cms: 'MIIcms' }))).toBe('ORG_EXISTS');
  });

  it('ИП — по ключу физлица: ИИН и ФИО', async () => {
    const ctx = await makeOrg(prisma);
    const iin = bin();
    stub(() => ok(cert({ keyUser: ['INDIVIDUAL'] }, { bin: undefined, organization: undefined, iin, commonName: 'ПЕТРОВА АННА', lastName: 'СЕРГЕЕВНА' })));
    const org = await svc.create(ctx.userId, { challengeId: svc.challenge(ctx.userId).challengeId, cms: 'MII' });
    created.push(org.id);
    expect([org.name, org.inn, org.legalForm]).toEqual(['ИП ПЕТРОВА АННА СЕРГЕЕВНА', iin, 'IP']);
  });

  it('отказы: сотрудник без права подписи, отозван, истёк, без OCSP, подпись неверна, цепочка не подтверждена — с записью в аудит', async () => {
    const ctx = await makeOrg(prisma);
    const cases: [EcpVerification, RegExp][] = [
      [ok(cert({ keyUser: ['ORGANIZATION', 'EMPLOYEE'] }, { bin: bin() })), /без права подписи/],
      [ok(cert({ revocations: [{ by: 'OCSP', revoked: true }] }, { bin: bin() })), /отозван/],
      [ok(cert({ notAfter: '2025-01-01T00:00:00Z' }, { bin: bin() })), /срок сертификата истёк/],
      [ok(cert({ revocations: [] }, { bin: bin() })), /OCSP/],
      [{ valid: false, signers: [{ status: 'INVALID', subIndication: 'SIG_CRYPTO_FAILURE', certificates: [cert({}, { bin: bin() })] }] }, /SIG_CRYPTO_FAILURE/],
      [ok(cert({ valid: false }, { bin: bin() })), /цепочка до НУЦ/],
      [{ valid: false, message: 'не CMS', signers: [] }, /не CMS/],
    ];
    for (const [v, re] of cases) {
      stub(() => v);
      const err = await svc.create(ctx.userId, { challengeId: svc.challenge(ctx.userId).challengeId, cms: 'MII' }).then(() => null, (e) => e);
      expect(err?.getResponse?.()?.code).toBe('ECP_REJECTED');
      expect(err.getResponse().message).toMatch(re);
    }
    expect(await prisma.auditLog.count({ where: { userId: ctx.userId, action: 'ORG_ECP_REJECTED' } })).toBe(cases.length);
  });

  it('форма собственности из наименования; права подписи — CAN_SIGN', () => {
    const name = (organization: string) => checkEcpSigner(ok(cert({}, { bin: '201240000123', organization })), new Date('2026-06-01')).org?.legalForm;
    expect([name('АО «Банк»'), name('Товарищество с ограниченной ответственностью "Х"'), name('ЖШС «Y»'), name('Учреждение «Z»'), name('ТООО «Q»')]).toEqual(['AO', 'TOO', 'TOO', 'OTHER', 'OTHER']);
    expect(checkEcpSigner(ok(cert({ keyUser: ['ORGANIZATION', 'CAN_SIGN'] })), new Date('2026-06-01')).problems).toEqual([]);
    expect(checkEcpSigner(ok(cert({ keyUser: ['ORGANIZATION', 'CAN_SIGN_FINANCIAL'] })), new Date('2026-06-01')).problems).toHaveLength(1);
    expect(checkEcpSigner({ valid: true, signers: [{ status: 'VALID', certificates: [cert()] }, { status: 'VALID', certificates: [cert()] }] }, new Date('2026-06-01')).problems).toContain('ожидается одна подпись');
  });
});

