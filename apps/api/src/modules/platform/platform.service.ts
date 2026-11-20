import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsSystem } from '../../common/db-context';
import { ON_BY_DEFAULT, SOLUTIONS, SOLUTION_LABELS, SOLUTION_NAMES, Solution, allSolutionStates, isSolution, parseSubscriptionInput, solutionState } from './subscriptions';
import { isPlatformAdmin } from './platform.guards';
import { kzDayRange, kzToday } from '../field/field-logic';

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

  /** Обзор платформы (ad.flowpos.kz): сколько клиентов, кто входил, что подключено, работа торговых. */
  async overview(now = new Date()) {
    return runAsSystem(async () => {
      const day = 24 * 3600 * 1000;
      const { from: todayFrom } = kzDayRange(kzToday(now));
      const [tenants, orgs, subs, users, active7, active30, reps, devices, seen24, visitsToday, visits7, ordersToday, recentLogins, recentEvents] = await Promise.all([
        this.prisma.tenant.count(),
        this.prisma.organization.findMany({ select: { id: true, name: true, isActive: true } }),
        this.prisma.orgSubscription.findMany(),
        this.prisma.user.count({ where: { isActive: true } }),
        this.prisma.user.count({ where: { isActive: true, lastLoginAt: { gte: new Date(now.getTime() - 7 * day) } } }),
        this.prisma.user.count({ where: { isActive: true, lastLoginAt: { gte: new Date(now.getTime() - 30 * day) } } }),
        this.prisma.fieldRep.count({ where: { isActive: true } }),
        this.prisma.fieldDevice.count({ where: { revokedAt: null } }),
        this.prisma.fieldDevice.count({ where: { revokedAt: null, lastSeenAt: { gte: new Date(now.getTime() - day) } } }),
        this.prisma.fieldVisit.count({ where: { startedAt: { gte: todayFrom } } }),
        this.prisma.fieldVisit.count({ where: { startedAt: { gte: new Date(todayFrom.getTime() - 6 * day) } } }),
        this.prisma.fieldOrder.count({ where: { at: { gte: todayFrom } } }),
        this.prisma.user.findMany({
          where: { lastLoginAt: { not: null } }, orderBy: { lastLoginAt: 'desc' }, take: 8,
          select: { email: true, firstName: true, lastName: true, lastLoginAt: true, organization: { select: { name: true } } },
        }),
        this.prisma.subscriptionEvent.findMany({ orderBy: { ts: 'desc' }, take: 8 }),
      ]);
      const [aiOrgs, aiActive, signups7] = await Promise.all([
        this.prisma.aiConnection.groupBy({ by: ['organizationId'], where: { revokedAt: null } }),
        this.prisma.aiConnection.count({ where: { revokedAt: null } }),
        this.prisma.auditLog.count({ where: { action: 'SELF_SIGNUP', ts: { gte: new Date(now.getTime() - 7 * day) } } }),
      ]);
      const bySolution = Object.fromEntries(SOLUTIONS.map((s) => [s, { enabled: 0, trial: 0, suspended: 0 }])) as Record<Solution, { enabled: number; trial: number; suspended: number }>;
      for (const o of orgs) {
        const states = allSolutionStates(subs.filter((r) => r.organizationId === o.id), now);
        for (const s of SOLUTIONS) {
          if (states[s].enabled) bySolution[s].enabled++;
          if (states[s].enabled && states[s].status === 'trial') bySolution[s].trial++;
          if (states[s].status === 'suspended' || (states[s].status !== 'none' && !states[s].enabled)) bySolution[s].suspended++;
        }
      }
      // Подписки, срок которых кончается в ближайшие 14 дней, — чтобы вовремя продлить.
      const soon = subs
        .filter((r) => r.validUntil && r.status !== 'suspended' && r.validUntil.getTime() >= now.getTime() && r.validUntil.getTime() < now.getTime() + 14 * day)
        .map((r) => ({ organizationId: r.organizationId, organization: orgs.find((o) => o.id === r.organizationId)?.name ?? '—', solution: r.solution, name: SOLUTION_NAMES[r.solution as Solution] ?? r.solution, validUntil: r.validUntil }));
      const eventUsers = await this.prisma.user.findMany({ where: { id: { in: recentEvents.map((e) => e.userId).filter(Boolean) as string[] } }, select: { id: true, email: true } });
      return {
        tenants,
        organizations: orgs.length,
        organizationsActive: orgs.filter((o) => o.isActive).length,
        users, active7, active30,
        solutions: SOLUTIONS.map((s) => ({ code: s, name: SOLUTION_NAMES[s], ...bySolution[s] })),
        field: { reps, devices, seen24, visitsToday, visits7, ordersToday },
        ai: { organizations: aiOrgs.length, connections: aiActive },
        signups7,
        expiringSoon: soon,
        recentLogins: recentLogins.map((u) => ({ email: u.email, name: `${u.firstName} ${u.lastName}`.trim(), organization: u.organization?.name ?? null, at: u.lastLoginAt })),
        recentEvents: recentEvents.map((e) => ({
          ts: e.ts, solution: e.solution, name: SOLUTION_NAMES[e.solution as Solution] ?? e.solution,
          organizationId: e.organizationId, organization: orgs.find((o) => o.id === e.organizationId)?.name ?? '—',
          userEmail: eventUsers.find((u) => u.id === e.userId)?.email ?? null, after: e.after,
        })),
      };
    });
  }

  /** Карточка организации: реквизиты, пользователи, подписки, торговые и их телефоны, история подписок. */
  async organization(id: string) {
    return runAsSystem(async () => {
      const org = await this.prisma.organization.findUnique({
        where: { id },
        select: { id: true, name: true, inn: true, legalForm: true, address: true, phone: true, email: true, isActive: true, createdAt: true, tenant: { select: { name: true } } },
      });
      if (!org) throw new NotFoundException('Организация не найдена');
      const [subs, members, reps, moysklad] = await Promise.all([
        this.prisma.orgSubscription.findMany({ where: { organizationId: id } }),
        this.prisma.orgMembership.findMany({
          where: { organizationId: id }, orderBy: { createdAt: 'asc' },
          select: { role: true, isActive: true, createdAt: true, user: { select: { id: true, email: true, firstName: true, lastName: true, isActive: true, lastLoginAt: true, mfaEnabledAt: true } } },
        }),
        this.prisma.fieldRep.findMany({
          where: { organizationId: id }, orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, phone: true, isActive: true, createdAt: true, devices: { orderBy: { createdAt: 'desc' }, select: { model: true, appVersion: true, lastSeenAt: true, revokedAt: true, createdAt: true } } },
        }),
        this.prisma.moyskladConnection.count({ where: { organizationId: id } }),
      ]);
      const [aiConnector, aiConnections, signup] = await Promise.all([
        this.prisma.aiConnector.findUnique({ where: { organizationId: id }, select: { enabled: true, updatedAt: true } }),
        this.prisma.aiConnection.findMany({ where: { organizationId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
        this.prisma.auditLog.findFirst({ where: { organizationId: id, action: 'SELF_SIGNUP' }, select: { ts: true } }),
      ]);
      const aiUsers = await this.prisma.user.findMany({ where: { id: { in: aiConnections.map((c) => c.userId) } }, select: { id: true, email: true } });
      return {
        ...org,
        client: org.tenant?.name ?? null,
        tenant: undefined,
        moyskladConnections: moysklad,
        solutions: allSolutionStates(subs),
        notes: Object.fromEntries(subs.map((s) => [s.solution, s.note])),
        members: members.map((m) => ({
          role: m.role, isActive: m.isActive && m.user.isActive, since: m.createdAt,
          userId: m.user.id, email: m.user.email, name: `${m.user.firstName} ${m.user.lastName}`.trim(), lastLoginAt: m.user.lastLoginAt, mfa: !!m.user.mfaEnabledAt,
        })),
        reps: reps.map((r) => ({ ...r, devices: r.devices.map((d) => ({ ...d, active: !d.revokedAt })) })),
        selfSignupAt: signup?.ts ?? null,
        ai: {
          enabled: aiConnector ? aiConnector.enabled : null, // null — компания ещё не открывала раздел
          connections: aiConnections.map((c) => ({ id: c.id, clientName: c.clientName, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, revokedAt: c.revokedAt, userEmail: aiUsers.find((u) => u.id === c.userId)?.email ?? null })),
        },
        events: await this.events(id),
      };
    });
  }

  /** Все пользователи всех клиентов. */
  async users(search?: string) {
    return runAsSystem(async () => {
      const q = (search || '').trim();
      const [rows, admins] = await Promise.all([
        this.prisma.user.findMany({
          where: q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] } : undefined,
          orderBy: [{ lastLoginAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          take: 500,
          select: {
            id: true, email: true, firstName: true, lastName: true, phone: true, isActive: true, lastLoginAt: true, mfaEnabledAt: true, createdAt: true,
            organization: { select: { id: true, name: true } },
            memberships: { where: { isActive: true }, select: { role: true, organization: { select: { id: true, name: true } } } },
          },
        }),
        this.prisma.platformAdmin.findMany({ select: { userId: true } }),
      ]);
      return rows.map((u) => ({
        id: u.id, email: u.email, name: `${u.firstName} ${u.lastName}`.trim(), phone: u.phone, isActive: u.isActive,
        lastLoginAt: u.lastLoginAt, mfa: !!u.mfaEnabledAt, createdAt: u.createdAt,
        organization: u.organization,
        memberships: u.memberships.map((m) => ({ role: m.role, organizationId: m.organization.id, organization: m.organization.name })),
        isPlatformAdmin: admins.some((a) => a.userId === u.id),
      }));
    });
  }

  /** Журнал действий платформы: подписки и администраторы платформы. */
  async journal(limit = 200) {
    return runAsSystem(async () => {
      const rows = await this.prisma.auditLog.findMany({
        where: { action: { in: [...PLATFORM_ACTIONS] } }, orderBy: { ts: 'desc' }, take: Math.min(Math.max(limit, 1), 500),
        select: { id: true, action: true, entity: true, entityId: true, before: true, after: true, ts: true, organizationId: true, user: { select: { email: true } } },
      });
      const orgs = await this.prisma.organization.findMany({ where: { id: { in: rows.map((r) => r.organizationId).filter(Boolean) as string[] } }, select: { id: true, name: true } });
      return rows.map((r) => ({ ...r, user: undefined, userEmail: r.user?.email ?? null, organization: orgs.find((o) => o.id === r.organizationId)?.name ?? null }));
    });
  }

  /** Кто администратор платформы (назначение — только скриптом на сервере). */
  async admins() {
    return runAsSystem(async () => {
      const rows = await this.prisma.platformAdmin.findMany({ orderBy: { createdAt: 'asc' } });
      const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, email: true, firstName: true, lastName: true, lastLoginAt: true, mfaEnabledAt: true } });
      return rows.map((r) => {
        const u = users.find((x) => x.id === r.userId);
        return { userId: r.userId, since: r.createdAt, email: u?.email ?? null, name: u ? `${u.firstName} ${u.lastName}`.trim() : null, lastLoginAt: u?.lastLoginAt ?? null, mfa: !!u?.mfaEnabledAt };
      });
    });
  }
}

/** Действия, которые показывает журнал платформы. */
export const PLATFORM_ACTIONS = ['SUBSCRIPTION_SET', 'PLATFORM_ADMIN_ADDED', 'PLATFORM_ADMIN_REMOVED', 'SELF_SIGNUP'] as const;
