import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsSystem } from '../../common/db-context';

export interface SignupInput {
  company: string;
  bin: string;
  legalForm?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  password: string;
}

const LEGAL_FORMS = ['TOO', 'IP', 'AO', 'OTHER'];

/** Проверка и нормализация анкеты регистрации. Ошибка — понятным текстом для формы. */
export function parseSignup(body: any): SignupInput {
  const s = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out: SignupInput = {
    company: s(body?.company),
    bin: s(body?.bin, 20).replace(/\s/g, ''),
    legalForm: LEGAL_FORMS.includes(body?.legalForm) ? body.legalForm : 'TOO',
    firstName: s(body?.firstName, 100),
    lastName: s(body?.lastName, 100),
    email: s(body?.email, 200).toLowerCase(),
    phone: s(body?.phone, 40) || undefined,
    password: typeof body?.password === 'string' ? body.password : '',
  };
  if (out.company.length < 2) throw new BadRequestException('Укажите название компании');
  if (!/^\d{12}$/.test(out.bin)) throw new BadRequestException('БИН или ИИН — 12 цифр');
  if (!out.firstName || !out.lastName) throw new BadRequestException('Укажите имя и фамилию');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) throw new BadRequestException('Неверный e-mail');
  if (out.password.length < 8 || out.password.length > 128) throw new BadRequestException('Пароль — от 8 до 128 символов');
  if (!/[A-Za-zА-Яа-яЁё]/.test(out.password) || !/\d/.test(out.password)) throw new BadRequestException('Пароль должен содержать буквы и цифры');
  return out;
}

/**
 * Самостоятельная регистрация компании на сайте: новый клиент (tenant), его организация, владелец,
 * учётная политика с типовым планом счетов. «Учётная система» и «Бухгалтерия» включены по умолчанию,
 * «Супервайзер» — по подписке (подключает администратор платформы).
 */
@Injectable()
export class SignupService {
  constructor(private prisma: PrismaService) {}

  async register(input: SignupInput, client: { ip?: string; userAgent?: string } = {}) {
    // До входа клиента нет: создание клиента и проверки — в системном режиме БД (как вход).
    return runAsSystem(async () => {
      if (await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
        throw new ConflictException('Этот e-mail уже зарегистрирован — войдите или восстановите пароль');
      }
      if (await this.prisma.organization.findFirst({ where: { inn: input.bin, isActive: true }, select: { id: true } })) {
        throw new ConflictException('Компания с этим БИН уже зарегистрирована. Попросите её владельца добавить вас пользователем.');
      }
      const passwordHash = await bcrypt.hash(input.password, 10);
      const adminRole = await this.prisma.role.upsert({ where: { name: 'admin' }, create: { name: 'admin', displayName: 'Администратор', isSystem: true }, update: {} });
      return this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: input.company } });
        const org = await tx.organization.create({
          data: { tenantId: tenant.id, name: input.company, inn: input.bin, legalForm: input.legalForm ?? 'TOO', phone: input.phone, email: input.email },
        });
        const user = await tx.user.create({
          data: { tenantId: tenant.id, email: input.email, passwordHash, firstName: input.firstName, lastName: input.lastName, phone: input.phone, organizationId: org.id },
        });
        await tx.userRole.create({ data: { userId: user.id, roleId: adminRole.id } });
        await tx.orgMembership.create({ data: { tenantId: tenant.id, userId: user.id, organizationId: org.id, role: 'owner' } });
        const chart = await tx.accChart.findFirst({ where: { code: 'KZ-TYPICAL' }, orderBy: { version: 'desc' } });
        await tx.accPolicy.create({
          data: { organizationId: org.id, validFrom: new Date('2020-01-01'), chartId: chart?.id, vatPayer: false, taxRegime: 'GENERAL', createdBy: user.id },
        });
        await tx.auditLog.create({
          data: { userId: user.id, organizationId: org.id, action: 'SELF_SIGNUP', entity: 'Organization', entityId: org.id, ipAddress: client.ip ?? null, after: { company: input.company, bin: input.bin, email: input.email } },
        });
        return { organizationId: org.id, userId: user.id };
      });
    });
  }
}
