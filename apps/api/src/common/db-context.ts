// FP-009: контекст клиента для запросов к БД. Каждый запрос Prisma выполняется в транзакции, где
// SET LOCAL flowpos.tenant_id берётся отсюда; политики RLS пропускают только строки этого клиента.
// Нет контекста — строк нет (fail-closed). Системный режим (вход до определения клиента, фоновые задачи
// по всем клиентам) включается только явно — runAsSystem.
import { AsyncLocalStorage } from 'async_hooks';

export interface DbContext {
  tenantId?: string;
  system?: boolean;
}

export const dbContext = new AsyncLocalStorage<DbContext>();

export const currentDbContext = (): DbContext => dbContext.getStore() ?? {};

// Запросы Prisma ленивые (PrismaPromise выполняется при await): ждать нужно внутри контекста,
// иначе запрос уйдёт уже вне его — поэтому async/await, а не просто вернуть результат fn().

/** Выполнить в системном режиме: RLS пропускает все строки. Только для серверного кода с собственной проверкой доступа. */
export function runAsSystem<T>(fn: () => PromiseLike<T> | T): Promise<T> {
  return dbContext.run({ system: true }, async () => await fn());
}

/** Выполнить от имени клиента (фоновая обработка одной организации). */
export function runAsTenant<T>(tenantId: string, fn: () => PromiseLike<T> | T): Promise<T> {
  return dbContext.run({ tenantId }, async () => await fn());
}

/**
 * Связать текущий запрос с клиентом проверенной сессии (JwtStrategy). Вне запроса (нет контекста) — ничего:
 * запросы без контекста под рабочей ролью и так не видят строк (fail-closed).
 */
export function bindRequestTenant(tenantId: string) {
  const store = dbContext.getStore();
  if (!store) return;
  store.tenantId = tenantId;
  store.system = false;
}
