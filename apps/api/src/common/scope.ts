// FP-007: область данных для старых модулей (каталог, торговля, HR, касса, аналитика, пользователи).
// Клиент и организация — из пользователя, которого JwtStrategy проверил по БД; из запроса — никогда.
import { BadRequestException, ExecutionContext, ForbiddenException, NotFoundException, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface Scope {
  tenantId: string;
  organizationId: string;
  userId: string;
}

export const CurrentScope = createParamDecorator((_: unknown, ctx: ExecutionContext): Scope => {
  const user = ctx.switchToHttp().getRequest().user;
  if (!user?.sub || !user?.tenantId || !user?.organizationId) throw new UnauthorizedException('Нет пользователя');
  return { tenantId: user.tenantId, organizationId: user.organizationId, userId: user.sub };
});

/** Справочник клиента: общий (без организации) или своей организации. */
export const tenantCatalog = (s: Scope) => ({ tenantId: s.tenantId, OR: [{ organizationId: null }, { organizationId: s.organizationId }] });

/** Объект организации. */
export const ownOrg = (s: Scope) => ({ organizationId: s.organizationId });

/**
 * Тело запроса без полей, которые задаёт сервер: id, клиент, организация, служебные даты.
 * organizationId справочника допускается только свой: тогда запись — личная для организации, иначе — общая для клиента.
 */
export function writable<T extends Record<string, any>>(body: T, s: Scope, opts: { privateAllowed?: boolean } = {}) {
  const { id, tenantId, organizationId, createdAt, updatedAt, ...rest } = (body ?? {}) as any;
  if (organizationId && organizationId !== s.organizationId) throw new ForbiddenException('Нельзя записывать в другую организацию');
  return { data: rest as Omit<T, 'id' | 'tenantId' | 'organizationId' | 'createdAt' | 'updatedAt'>, private: !!(opts.privateAllowed && organizationId) };
}

/** Ошибки ссылок и отсутствия записи — понятным ответом, а не 500. */
export function scopeError(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2003') throw new BadRequestException('Ссылка на объект, которого нет у этой организации или клиента');
    if (e.code === 'P2025') throw new NotFoundException('Запись не найдена');
  }
  throw e;
}

/** Документ организации. У старых документов (POS, 1С) organization_id бывает пустым — тогда по складу. */
export const orgDocument = (s: Scope) => ({
  tenantId: s.tenantId,
  OR: [{ organizationId: s.organizationId }, { organizationId: null, store: { organizationId: s.organizationId } }],
});
