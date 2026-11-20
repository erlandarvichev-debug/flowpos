import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsSystem } from '../../common/db-context';
import { ON_BY_DEFAULT, SOLUTIONS, SOLUTION_LABELS, SOLUTION_NAMES, Solution, allSolutionStates, isSolution, parseSubscriptionInput, solutionState } from './subscriptions';
import { isPlatformAdmin } from './platform.guards';

@Injectable()
export class PlatformService {
  constructor(private prisma: PrismaService) {}

  solutions() {
    return SOLUTIONS.map((code) => ({ code, name: SOLUTION_NAMES[code], label: SOLUTION_LABELS[code], onByDefault: ON_BY_DEFAULT.includes(code) }));
  }

  async me(userId: string) {
    return { isPlatformAdmin: await isPlatformAdmin(this.prisma, userId) };
  }

  /** Решения текущей организации — для меню сайта. */
  async mine(organizationId: string) {
    const rows = await this.prisma.orgSubscription.findMany({ where: { organizationId } });
    return allSolutionStates(rows);
  }

  /** Все организации платформы (всех клиентов) с подписками. Только администратору платформы. */
  async organizations(search?: string) {
    return runAsSystem(async () => {
      const q = (search || '').trim();
      const orgs = await this.prisma.organization.findMany({
        where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { inn: { contains: q } }] } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { id: true, tenantId: true, name: true, inn: true, legalForm: true, isActive: true, createdAt: true, tenant: { select: { name: true } } },
      });
      const ids = orgs.map((o) => o.id);
      const [subs, members, owners, reps] = await Promise.all([
        this.prisma.orgSubscription.findMany({ where: { organizationId: { in: ids } } }),
        this.prisma.orgMembership.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, isActive: true }, _count: { _all: true } }),
        this.prisma.orgMembership.findMany({
          where: { organizationId: { in: ids }, role: 'owner', isActive: true },
          select: { organizationId: true, user: { select: { email: true, firstName: true, lastName: true } } },
        }),
        this.prisma.fieldRep.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, isActive: true }, _count: { _all: true } }),
      ]);
      return orgs.map((o) => ({
        id: o.id,
        name: o.name,
        inn: o.inn,
        legalForm: o.legalForm,
        isActive: o.isActive,
        createdAt: o.createdAt,
        client: o.tenant?.name ?? null,
        members: members.find((m) => m.organizationId === o.id)?._count._all ?? 0,
        reps: reps.find((m) => m.organizationId === o.id)?._count._all ?? 0,
        owners: owners.filter((m) => m.organizationId === o.id).map((m) => ({ email: m.user.email, name: `${m.user.firstName} ${m.user.lastName}`.trim() })),
        solutions: allSolutionStates(subs.filter((s) => s.organizationId === o.id)),
        notes: Object.fromEntries(subs.filter((s) => s.organizationId === o.id).map((s) => [s.solution, s.note])),
      }));
    });
  }

  /** Подключить, продлить или приостановить решение у организации; запись в журнал подписок. */
  async setSubscription(userId: string, organizationId: string, solution: string, body: any) {
    if (!isSolution(solution)) throw new BadRequestException('Неизвестное решение');
    let input;
    try { input = parseSubscriptionInput(body); } catch (e: any) { throw new BadRequestException(e.message); }
    return runAsSystem(() => this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true, tenantId: true } });
      if (!org) throw new NotFoundException('Организация не найдена');
      const before = await tx.orgSubscription.findUnique({ where: { organizationId_solution: { organizationId, solution } } });
      const data = { status: input.status, validUntil: input.validUntil, seats: input.seats, note: input.note, updatedBy: userId };
      const after = before
        ? await tx.orgSubscription.update({ where: { id: before.id }, data })
        : await tx.orgSubscription.create({ data: { ...data, tenantId: org.tenantId, organizationId, solution } });
      const snap = (r: typeof after | null) => (r ? { status: r.status, validUntil: r.validUntil, seats: r.seats, note: r.note } : null);
      await tx.subscriptionEvent.create({
        data: { tenantId: org.tenantId, organizationId, solution, userId, before: snap(before) as any, after: snap(after) as any },
      });
      await tx.auditLog.create({
        data: { userId, organizationId, action: 'SUBSCRIPTION_SET', entity: 'org_subscription', entityId: after.id, before: snap(before) as any, after: snap(after) as any },
      });
      return solutionState(solution as Solution, after);
    }));
  }

  async events(organizationId: string) {
    return runAsSystem(async () => {
      const rows = await this.prisma.subscriptionEvent.findMany({ where: { organizationId }, orderBy: { ts: 'desc' }, take: 100 });
      const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean) as string[])];
      const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
      return rows.map((r) => ({ ...r, userEmail: users.find((u) => u.id === r.userId)?.email ?? null }));
    });
  }
}
