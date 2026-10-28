import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'crypto';
import { Observable, from, of } from 'rxjs';
import { switchMap, concatMap, catchError } from 'rxjs/operators';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccError } from './acc-error';

/**
 * Идемпотентность изменяющих запросов: заголовок Idempotency-Key.
 * Повтор с тем же ключом и телом возвращает сохранённый ответ; с другим телом — 409.
 * Параллельный повтор, пока первый в работе, — 409 (повторите позже).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['idempotency-key'];
    const org = req.orgContext?.organizationId;
    if (!key || !org || req.method === 'GET') return next.handle();
    const hash = createHash('sha256').update(JSON.stringify({ m: req.method, p: req.path, b: req.body ?? null })).digest('hex');
    return from(
      this.prisma.$executeRaw`
        INSERT INTO idempotency_records (organization_id, key, method, path, request_hash)
        VALUES (${org}, ${String(key)}, ${req.method}, ${req.path}, ${hash}) ON CONFLICT DO NOTHING`,
    ).pipe(
      switchMap(async (inserted) => {
        if (inserted) return null;
        const rec = await this.prisma.idempotencyRecord.findUnique({ where: { organizationId_key: { organizationId: org, key: String(key) } } });
        if (rec?.requestHash !== hash) throw new AccError('IDEMPOTENCY_MISMATCH', 'Ключ Idempotency-Key уже использован для другого запроса', { status: 409 });
        if (rec.statusCode === null) throw new AccError('IDEMPOTENCY_IN_PROGRESS', 'Такой же запрос ещё выполняется — повторите через несколько секунд', { status: 409 });
        return { replay: rec.response };
      }),
      switchMap((r) => {
        if (r) {
          ctx.switchToHttp().getResponse().setHeader('Idempotent-Replay', 'true');
          return of(r.replay);
        }
        return next.handle().pipe(
          concatMap(async (body) => {
            await this.prisma.idempotencyRecord.update({
              where: { organizationId_key: { organizationId: org, key: String(key) } },
              data: { statusCode: 200, response: JSON.parse(JSON.stringify(body ?? null)) },
            });
            return body;
          }),
          catchError(async (err) => {
            // Ошибка — ключ освобождается, запрос можно повторить
            await this.prisma.idempotencyRecord.delete({ where: { organizationId_key: { organizationId: org, key: String(key) } } }).catch(() => undefined);
            throw err;
          }),
        );
      }),
    );
  }
}
