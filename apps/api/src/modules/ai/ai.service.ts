import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsSystem } from '../../common/db-context';
import { Scope } from '../../common/scope';

/**
 * ИИ-помощник (MCP для Claude). У каждой компании свой адрес коннектора https://<сайт>/mcp/c/<код>:
 * Claude, подключённый по нему, работает только с этой компанией. Подключения (гранты MCP) записываются
 * сюда, и каждый запрос MCP к API проверяется (OrgGuard → assertAiConnection): отключённое — перестаёт работать сразу.
 */

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // без похожих символов (l/1, o/0)
export function newConnectorCode(len = 12): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
export const isConnectorCode = (v: unknown): v is string => typeof v === 'string' && /^[a-z2-9]{12}$/.test(v);
export const isConnectionId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

export const AI_CONNECTION_HEADER = 'x-ai-connection';
const TOUCH_EVERY_MS = 5 * 60 * 1000;

/**
 * Запрос пришёл от ИИ-помощника (заголовок X-AI-Connection): подключение должно существовать, не быть отозванным,
 * принадлежать этому пользователю и этой организации, а помощник компании — быть включён.
 */
export async function assertAiConnection(prisma: PrismaService, connectionId: string, organizationId: string, userId: string, now = new Date()) {
  if (!isConnectionId(connectionId)) throw new ForbiddenException('Неверное подключение ИИ-помощника');
  await runAsSystem(async () => {
    const [conn, connector] = await Promise.all([
      prisma.aiConnection.findUnique({ where: { id: connectionId } }),
      prisma.aiConnector.findUnique({ where: { organizationId }, select: { enabled: true } }),
    ]);
    if (!conn || conn.organizationId !== organizationId || conn.userId !== userId) throw new ForbiddenException('ИИ-помощник не подключён к этой компании');
    if (conn.revokedAt) throw new ForbiddenException('Подключение ИИ-помощника отключено в FlowPOS — подключите заново');
    if (!connector?.enabled) throw new ForbiddenException('ИИ-помощник выключен в настройках компании');
    if (!conn.lastUsedAt || now.getTime() - conn.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await prisma.aiConnection.update({ where: { id: conn.id }, data: { lastUsedAt: now } });
    }
  });
}

@Injectable()
export class AiService {
  constructor(private prisma: PrismaService) {}

  /** Коннектор компании; при первом обращении создаётся (включён). */
  async connector(s: Scope) {
    const existing = await this.prisma.aiConnector.findUnique({ where: { organizationId: s.organizationId } });
    const row = existing ?? await this.prisma.aiConnector.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, code: newConnectorCode(), updatedBy: s.userId } });
    return { code: row.code, enabled: row.enabled, updatedAt: row.updatedAt };
  }

  async setEnabled(s: Scope, enabled: boolean) {
    await this.connector(s);
    const row = await this.prisma.aiConnector.update({ where: { organizationId: s.organizationId }, data: { enabled: !!enabled, updatedBy: s.userId } });
    await this.audit(s, enabled ? 'AI_CONNECTOR_ENABLED' : 'AI_CONNECTOR_DISABLED', row.id);
    return { code: row.code, enabled: row.enabled, updatedAt: row.updatedAt };
  }

  /** Новый адрес: старый перестаёт работать, все подключения отключаются. */
  async rotate(s: Scope) {
    await this.connector(s);
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.aiConnector.update({ where: { organizationId: s.organizationId }, data: { code: newConnectorCode(), updatedBy: s.userId } });
      await tx.aiConnection.updateMany({ where: { organizationId: s.organizationId, revokedAt: null }, data: { revokedAt: now, revokedBy: s.userId } });
      return r;
    });
    await this.audit(s, 'AI_CONNECTOR_ROTATED', row.id);
    return { code: row.code, enabled: row.enabled, updatedAt: row.updatedAt };
  }

  async connections(s: Scope) {
    const rows = await this.prisma.aiConnection.findMany({ where: { organizationId: s.organizationId }, orderBy: { createdAt: 'desc' }, take: 200 });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, email: true, firstName: true, lastName: true } });
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.userId);
      return { id: r.id, clientName: r.clientName, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt, active: !r.revokedAt, userEmail: u?.email ?? null, userName: u ? `${u.firstName} ${u.lastName}`.trim() : null, mine: r.userId === s.userId };
    });
  }

  /** Отключить подключение: администратор — любое, участник — своё. */
  async revoke(s: Scope, id: string, canManage: boolean) {
    const row = await this.prisma.aiConnection.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!row) throw new NotFoundException('Подключение не найдено');
    if (!canManage && row.userId !== s.userId) throw new ForbiddenException('Отключить можно только своё подключение');
    if (!row.revokedAt) {
      await this.prisma.aiConnection.update({ where: { id }, data: { revokedAt: new Date(), revokedBy: s.userId } });
      await this.audit(s, 'AI_CONNECTION_REVOKED', id);
    }
    return { ok: true };
  }

  /** Для MCP: компания по коду из адреса коннектора. Код случайный, по нему видно только название. */
  async byCode(code: string) {
    if (!isConnectorCode(code)) throw new NotFoundException('Адрес коннектора не найден');
    return runAsSystem(async () => {
      const row = await this.prisma.aiConnector.findUnique({ where: { code } });
      if (!row) throw new NotFoundException('Адрес коннектора не найден — возьмите актуальный в FlowPOS: Настройки → ИИ-помощник');
      const org = await this.prisma.organization.findUnique({ where: { id: row.organizationId }, select: { name: true, isActive: true } });
      if (!org?.isActive) throw new NotFoundException('Компания не активна');
      return { organizationId: row.organizationId, organization: org.name, enabled: row.enabled };
    });
  }

  /** MCP записывает подключение при первом запросе Claude к компании (пользователь уже проверен OrgGuard). */
  async register(s: Scope, body: any) {
    const id = body?.id;
    if (!isConnectionId(id)) throw new ForbiddenException('Неверный идентификатор подключения');
    const connector = await this.prisma.aiConnector.findUnique({ where: { organizationId: s.organizationId } });
    if (!connector?.enabled) throw new ForbiddenException('ИИ-помощник выключен в настройках компании');
    const existing = await runAsSystem(() => this.prisma.aiConnection.findUnique({ where: { id } }));
    if (existing) {
      if (existing.organizationId !== s.organizationId || existing.userId !== s.userId) throw new ConflictException('Подключение принадлежит другой компании');
      if (existing.revokedAt) throw new ForbiddenException('Подключение ИИ-помощника отключено в FlowPOS — подключите заново');
      return { id, organizationId: s.organizationId };
    }
    const clientName = typeof body?.clientName === 'string' ? body.clientName.trim().slice(0, 100) || null : null;
    await this.prisma.aiConnection.create({ data: { id, tenantId: s.tenantId, organizationId: s.organizationId, userId: s.userId, clientName, lastUsedAt: new Date() } });
    await this.audit(s, 'AI_CONNECTION_CREATED', id, { clientName });
    return { id, organizationId: s.organizationId };
  }

  private audit(s: Scope, action: string, entityId: string, after?: any) {
    return this.prisma.auditLog.create({ data: { userId: s.userId, organizationId: s.organizationId, action, entity: 'ai', entityId, after: after ?? undefined } });
  }
}
