import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsSystem } from '../../common/db-context';
import { PHOTO_RETENTION_DAYS } from './field-logic';

/**
 * Файлы фото посещений. Каталог — вне релиза (релизы стираются): в бою /opt/flowpos/shared/data/field,
 * иначе ./data/field; переопределяется FIELD_DATA_DIR. Раз в сутки удаляются фото старше 180 дней.
 */
@Injectable()
export class FieldPhotoStore implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('FieldPhotos');
  private timer?: NodeJS.Timeout;
  readonly root = path.resolve(
    process.env.FIELD_DATA_DIR || (process.env.NODE_ENV === 'production' ? '/opt/flowpos/shared/data/field' : path.join(process.cwd(), 'data', 'field')),
  );

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.FIELD_CLEANUP === '0' || process.env.NODE_ENV === 'test') return;
    const run = () => this.cleanup().catch((e) => this.log.error(`Очистка фото: ${e.message}`));
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, 24 * 3600 * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Путь файла внутри каталога данных; выход за пределы каталога невозможен. */
  resolve(rel: string) {
    const full = path.resolve(this.root, rel);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Неверный путь файла');
    return full;
  }

  async save(organizationId: string, id: string, ext: string, buf: Buffer): Promise<string> {
    const month = new Date().toISOString().slice(0, 7);
    const rel = path.posix.join(organizationId, month, `${id}.${ext}`);
    const full = this.resolve(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf, { flag: 'wx' });
    return rel;
  }

  read(rel: string) {
    return fs.readFile(this.resolve(rel));
  }

  async remove(rel: string) {
    await fs.rm(this.resolve(rel), { force: true });
  }

  /** Удалить фото старше срока хранения: сначала файл, потом строку. */
  async cleanup(now = new Date()) {
    const before = new Date(now.getTime() - PHOTO_RETENTION_DAYS * 24 * 3600 * 1000);
    let removed = 0;
    for (;;) {
      const rows = await runAsSystem(() => this.prisma.fieldPhoto.findMany({ where: { createdAt: { lt: before } }, select: { id: true, path: true }, take: 500 }));
      if (!rows.length) break;
      for (const r of rows) await this.remove(r.path).catch(() => undefined);
      await runAsSystem(() => this.prisma.fieldPhoto.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }));
      removed += rows.length;
    }
    if (removed) this.log.log(`Удалено фото старше ${PHOTO_RETENTION_DAYS} дней: ${removed}`);
    return removed;
  }
}
