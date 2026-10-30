// FP-009: клиент БД воркера с контекстом клиента (tenant) для RLS. Та же логика, что в API
// (apps/api/src/prisma/prisma.service.ts и common/db-context.ts) — копия, потому что воркеры собираются отдельно.
// Воркер работает под рабочей ролью без BYPASSRLS: перечень подключений/очередей — runAsSystem,
// запись данных клиента — runAsTenant(tenantId). Нет контекста — строк нет (fail-closed).
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

interface DbContext {
  tenantId?: string;
  system?: boolean;
}

const dbContext = new AsyncLocalStorage<DbContext>();

// Запросы Prisma ленивые: ждать нужно внутри контекста.
export function runAsSystem<T>(fn: () => PromiseLike<T> | T): Promise<T> {
  return dbContext.run({ system: true }, async () => await fn());
}

export function runAsTenant<T>(tenantId: string, fn: () => PromiseLike<T> | T): Promise<T> {
  return dbContext.run({ tenantId }, async () => await fn());
}

const RAW = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe']);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** Адрес БД для следующего созданного клиента (тесты: рабочая роль). Nest создаёт клиент без аргументов. */
  static nextUrl?: string;

  constructor() {
    const url = PrismaService.nextUrl;
    PrismaService.nextUrl = undefined;
    super(url ? { datasourceUrl: url } : undefined);
    const base = this as PrismaClient;
    const ctx = (db: { $executeRaw: PrismaClient['$executeRaw'] }) => {
      const c = dbContext.getStore() ?? {};
      return db.$executeRaw`SELECT set_config('flowpos.tenant_id', ${c.tenantId ?? ''}, true), set_config('flowpos.system', ${c.system ? 'on' : 'off'}, true)`;
    };
    const extended = base.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            const [, result] = await base.$transaction([ctx(base), query(args) as any]);
            return result;
          },
        },
      },
    });
    return new Proxy(extended, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (arg: any, opts?: any) =>
            typeof arg === 'function'
              ? base.$transaction(async (tx) => {
                  await ctx(tx);
                  return arg(tx);
                }, opts)
              : base.$transaction([ctx(base), ...arg], opts).then((r: any[]) => r.slice(1));
        }
        if (typeof prop === 'string' && RAW.has(prop)) {
          return (...a: any[]) => base.$transaction([ctx(base), (base as any)[prop](...a)]).then((r: any[]) => r[1]);
        }
        if (prop === 'onModuleInit' || prop === 'onModuleDestroy' || prop === '$connect' || prop === '$disconnect') {
          return (base as any)[prop].bind(base);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as PrismaService;
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
