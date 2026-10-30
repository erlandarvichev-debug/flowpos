import { Injectable, NestMiddleware } from '@nestjs/common';
import { dbContext } from './db-context';

/** Пустой контекст БД на каждый HTTP-запрос; клиента в него записывает JwtStrategy после проверки сессии. */
@Injectable()
export class DbContextMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    dbContext.run({}, next);
  }
}
