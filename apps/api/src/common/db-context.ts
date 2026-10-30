// FP-009: контекст клиента для запросов к БД. Каждый запрос Prisma выполняется в транзакции, где
// SET LOCAL flowpos.tenant_id берётся отсюда; политики RLS пропускают только строки этого клиента.
// Нет контекста — строк нет (fail-closed). Системный режим (вход до определения клиента, фоновые задачи
// по всем клиентам) включается только явно — runAsSystem.
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface DbContext {
  tenantId?: string;
  system?: boolean;
  /** FP-022: код трассировки — связывает действие в интерфейсе, фоновую задачу, вызов шлюза и запись журнала. */
  traceId?: string;
}

export const dbContext = new AsyncLocalStorage<DbContext>();

export const currentDbContext = (): DbContext => dbContext.getStore() ?? {};

// Запросы Prisma ленивые (PrismaPromise выполняется при await): ждать нужно внутри контекста,
// иначе запрос уйдёт уже вне его — поэтому async/await, а не просто вернуть результат fn().

/** Выполнить в системном режиме: RLS пропускает все строки. Только для серверного кода с собственной проверкой доступа. */
export function runAsSystem<T>(fn: () => PromiseLike<T> | T): Promise<T> {
  return dbContext.run({ system: true, traceId: currentDbContext().traceId }, async () => await fn());
}

/** Выполнить от имени клиента (фоновая обработка одной организации). */
export function runAsTenant<T>(tenantId: string, fn: () => PromiseLike<T> | T): Promise<T> {
  return dbContext.run({ tenantId, traceId: currentDbContext().traceId }, async () => await fn());
}

/** Новый код трассировки (UUID). */
export const newTraceId = () => randomUUID();

/** Входящий код трассировки принимается только в безопасной форме (попадает в логи и заголовки). */
export const validTraceId = (v: unknown): string | undefined => (typeof v === 'string' && /^[\w-]{8,64}$/.test(v) ? v : undefined);

/** Выполнить фоновую задачу под своим кодом трассировки (например, `esf-tick:<uuid>`). */
export function runWithTrace<T>(traceId: string, fn: () => PromiseLike<T> | T): Promise<T> {
  return dbContext.run({ ...currentDbContext(), traceId }, async () => await fn());
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
