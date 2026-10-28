import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';

const DAY = 24 * 3600 * 1000;

export function dateOnly(d: Date | string): Date {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

export interface OverrideRequest {
  reason?: string;
}

@Injectable()
export class PeriodsService {
  constructor(private prisma: PrismaService) {}

  async getLock(organizationId: string) {
    return this.prisma.accPeriodLock.findUnique({ where: { organizationId } });
  }

  /**
   * Проверяет, что дата в открытом периоде. Берёт разделяемую блокировку организации,
   * чтобы закрытие периода не прошло параллельно с проведением.
   * Изменение закрытого периода — только с правом acc.period.override и причиной (пишется в аудит).
   */
  async assertOpen(
    tx: Prisma.TransactionClient,
    ctx: OrgContext,
    dates: (Date | string)[],
    override?: OverrideRequest,
    what = 'операция',
  ) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${'acc-period:' + ctx.organizationId}))::text`;
    const lock = await tx.accPeriodLock.findUnique({ where: { organizationId: ctx.organizationId } });
    if (!lock) return;
    const closedDates = dates.filter((d) => dateOnly(d).getTime() <= lock.lockedUntil.getTime());
    if (!closedDates.length) return;
    const lockedStr = lock.lockedUntil.toISOString().slice(0, 10);
    if (!override?.reason) {
      throw new AccError('PERIOD_CLOSED', `Период закрыт по ${lockedStr}: ${what} на ${dateOnly(closedDates[0]).toISOString().slice(0, 10)} невозможна`, {
        fix: 'Укажите дату в открытом периоде или оформите сторно текущей датой. Изменить закрытый период может главный бухгалтер с указанием причины.',
        link: '/accounting/periods',
        status: 409,
      });
    }
    if (!ctx.can('acc.period.override')) {
      throw new AccError('PERIOD_OVERRIDE_FORBIDDEN', 'Нет права изменять закрытый период', {
        fix: 'Обратитесь к главному бухгалтеру или владельцу.',
        status: 403,
      });
    }
    await tx.auditLog.create({
      data: {
        userId: ctx.userId, organizationId: ctx.organizationId, action: 'PERIOD_OVERRIDE', entity: 'AccPeriodLock',
        entityId: ctx.organizationId, reason: override.reason,
        after: { lockedUntil: lockedStr, dates: closedDates.map((d) => new Date(d).toISOString()), what },
      },
    });
  }

  /** Закрыть/переоткрыть период. Эксклюзивная блокировка — ждёт завершения проведений. */
  async setLock(ctx: OrgContext, lockedUntil: string | null, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'acc-period:' + ctx.organizationId}))::text`;
      const before = await tx.accPeriodLock.findUnique({ where: { organizationId: ctx.organizationId } });
      const newDate = lockedUntil ? dateOnly(lockedUntil) : null;
      const reopening = before && (!newDate || newDate.getTime() < before.lockedUntil.getTime());
      if (reopening) {
        if (!ctx.can('acc.period.override')) {
          throw new AccError('PERIOD_OVERRIDE_FORBIDDEN', 'Открыть закрытый период может только главный бухгалтер или владелец', { status: 403 });
        }
        if (!reason) throw new AccError('REASON_REQUIRED', 'Укажите причину открытия закрытого периода');
      }
      let result: any = null;
      if (newDate) {
        result = await tx.accPeriodLock.upsert({
          where: { organizationId: ctx.organizationId },
          create: { organizationId: ctx.organizationId, lockedUntil: newDate, updatedById: ctx.userId },
          update: { lockedUntil: newDate, updatedById: ctx.userId },
        });
      } else if (before) {
        await tx.accPeriodLock.delete({ where: { organizationId: ctx.organizationId } });
      }
      await tx.auditLog.create({
        data: {
          userId: ctx.userId, organizationId: ctx.organizationId, action: reopening ? 'PERIOD_REOPEN' : 'PERIOD_LOCK',
          entity: 'AccPeriodLock', entityId: ctx.organizationId, reason,
          before: before ? { lockedUntil: before.lockedUntil } : undefined,
          after: newDate ? { lockedUntil: newDate } : { lockedUntil: null },
        },
      });
      return result ?? { organizationId: ctx.organizationId, lockedUntil: null };
    });
  }
}

export { DAY };
