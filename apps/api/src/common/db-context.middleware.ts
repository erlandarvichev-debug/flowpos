import { Injectable, NestMiddleware } from '@nestjs/common';
import { dbContext, newTraceId, validTraceId } from './db-context';

/**
 * Пустой контекст БД на каждый HTTP-запрос; клиента в него записывает JwtStrategy после проверки сессии.
 * FP-022: код трассировки — из заголовка X-Request-Id (веб присылает свой на каждое действие) или новый;
 * возвращается в ответе, чтобы пользователь мог назвать его поддержке.
 */
@Injectable()
export class DbContextMiddleware implements NestMiddleware {
  use(req: { headers: Record<string, unknown> }, res: { setHeader(name: string, value: string): void }, next: () => void) {
    const traceId = validTraceId(req.headers['x-request-id']) ?? newTraceId();
    res.setHeader('X-Request-Id', traceId);
    dbContext.run({ traceId }, next);
  }
}
