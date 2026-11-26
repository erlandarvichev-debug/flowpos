import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from '../common/acc-error';
import { OrgContext } from '../access/org-context';

export const FILE_MAX_BYTES = 15 * 1024 * 1024;
/** Разрешённые файлы: документы, таблицы, картинки, архивы. Исполняемые и HTML — нет. */
const ALLOWED = /\.(pdf|docx?|xlsx?|csv|txt|odt|ods|jpe?g|png|webp|heic|gif|zip|rar|7z|xml)$/i;
export interface UploadedFileLike { originalname: string; mimetype: string; size: number; buffer: Buffer }

/**
 * Файлы к документам и контрагентам. Каталог — вне релиза (релизы стираются): в бою /opt/flowpos/shared/data/files,
 * иначе ./data/files; переопределяется FILES_DATA_DIR. Выход за пределы каталога невозможен.
 */
@Injectable()
export class FilesService {
  readonly root = path.resolve(
    process.env.FILES_DATA_DIR || (process.env.NODE_ENV === 'production' ? '/opt/flowpos/shared/data/files' : path.join(process.cwd(), 'data', 'files')),
  );
  constructor(private prisma: PrismaService) {}

  private full(rel: string) {
    const f = path.resolve(this.root, rel);
    if (!f.startsWith(this.root + path.sep)) throw new Error('Неверный путь файла');
    return f;
  }

  private async checkEntity(ctx: OrgContext, type: string, id: string) {
    const ok = type === 'COUNTERPARTY'
      ? await this.prisma.counterparty.findFirst({ where: { id, tenantId: ctx.tenantId, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] }, select: { id: true } })
      : type === 'ACC'
        ? await this.prisma.accDocument.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })
        : type === 'TRADE'
          ? await this.prisma.document.findFirst({ where: { id, OR: [{ organizationId: ctx.organizationId }, { organizationId: null, store: { organizationId: ctx.organizationId } }] }, select: { id: true } })
          : null;
    if (!ok) throw new AccError('NOT_FOUND', 'Документ или контрагент не найден', { status: 404 });
  }

  async list(ctx: OrgContext, type: string, id: string) {
    await this.checkEntity(ctx, type, id);
    const rows = await this.prisma.attachment.findMany({ where: { organizationId: ctx.organizationId, entityType: type, entityId: id }, orderBy: { createdAt: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdBy))] } }, select: { id: true, email: true, firstName: true, lastName: true } });
    return rows.map(({ path: _p, ...r }) => { const u = users.find((x) => x.id === r.createdBy); return { ...r, author: u ? [u.lastName, u.firstName].filter(Boolean).join(' ') || u.email : null }; });
  }

  async upload(ctx: OrgContext, type: string, id: string, file?: UploadedFileLike) {
    if (!file) throw new AccError('FILE_REQUIRED', 'Выберите файл');
    if (file.size > FILE_MAX_BYTES) throw new AccError('FILE_TOO_BIG', 'Файл больше 15 МБ');
    // Имя из браузера приходит в latin1 — восстанавливаем UTF-8 (кириллица в названиях).
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
    if (!ALLOWED.test(name)) throw new AccError('FILE_TYPE', 'Можно прикреплять PDF, Word, Excel, CSV, картинки и архивы');
    await this.checkEntity(ctx, type, id);
    const fid = randomUUID();
    const rel = path.posix.join(ctx.organizationId, new Date().toISOString().slice(0, 7), `${fid}${path.extname(name).toLowerCase()}`);
    const full = this.full(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.buffer, { flag: 'wx' });
    try {
      await this.prisma.attachment.create({ data: { id: fid, tenantId: ctx.tenantId, organizationId: ctx.organizationId, entityType: type, entityId: id, fileName: name, mime: file.mimetype || 'application/octet-stream', size: file.size, path: rel, createdBy: ctx.userId } });
    } catch (e) { await fs.rm(full, { force: true }); throw e; }
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'FILE_ATTACH', entity: type === 'COUNTERPARTY' ? 'counterparty' : 'document', entityId: id, after: { fileName: name, size: file.size } } });
    return this.list(ctx, type, id);
  }

  async download(ctx: OrgContext, fileId: string) {
    const a = await this.prisma.attachment.findFirst({ where: { id: fileId, organizationId: ctx.organizationId } });
    if (!a) throw new AccError('NOT_FOUND', 'Файл не найден', { status: 404 });
    return { name: a.fileName, mime: a.mime, data: await fs.readFile(this.full(a.path)) };
  }

  async remove(ctx: OrgContext, fileId: string) {
    const a = await this.prisma.attachment.findFirst({ where: { id: fileId, organizationId: ctx.organizationId } });
    if (!a) throw new AccError('NOT_FOUND', 'Файл не найден', { status: 404 });
    if (a.createdBy !== ctx.userId && !ctx.can('org.members.manage')) throw new AccError('FORBIDDEN', 'Удалить файл может тот, кто его прикрепил, или руководитель', { status: 403 });
    await this.prisma.attachment.delete({ where: { id: a.id } });
    await fs.rm(this.full(a.path), { force: true });
    await this.prisma.auditLog.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, action: 'FILE_DELETE', entity: a.entityType === 'COUNTERPARTY' ? 'counterparty' : 'document', entityId: a.entityId, before: { fileName: a.fileName } } });
    return { ok: true };
  }
}
