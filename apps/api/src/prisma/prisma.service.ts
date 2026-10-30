import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { currentDbContext } from '../common/db-context';

const RAW = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe']);

/**
 * FP-009: клиент БД с контекстом клиента (tenant) для RLS. Тип — прежний PrismaClient, поведение:
 * - запрос модели или сырой SQL — транзакция из двух операторов: set_config(...) и сам запрос;
 * - $transaction(fn) — контекст выставляется первым оператором той же транзакции, fn получает обычный tx;
 * - $transaction([...]) — set_config добавляется первым в пакет.
 * Значения — transaction-local (set_config(..., true)): после commit соединение пула чистое.
 * Под ролью с BYPASSRLS (владелец/миграции) контекст ни на что не влияет.
 */
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
      const c = currentDbContext();
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

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
