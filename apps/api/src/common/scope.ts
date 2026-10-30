// FP-007/FP-008: область данных для старых модулей (каталог, торговля, HR, касса, аналитика, пользователи, обмен).
// Клиент и организация — из членства, которое проверил OrgGuard (организация из X-Organization-Id или своя,
// членство активно, право из @RequirePermission); из тела запроса — никогда.
import { BadRequestException, ExecutionContext, ForbiddenException, NotFoundException, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface Scope {
  tenantId: string;
  organizationId: string;
  userId: string;
  /** Роль в организации (из членства). */
  role?: string;
}

/** Область запроса. Только под OrgGuard: без проверенного членства — отказ, а не «организация пользователя по умолчанию». */
export const CurrentScope = createParamDecorator((_: unknown, ctx: ExecutionContext): Scope => {
  const oc = ctx.switchToHttp().getRequest().orgContext;
  if (!oc?.tenantId || !oc?.organizationId || !oc?.userId) throw new UnauthorizedException('Нет проверенного доступа к организации');
  return { tenantId: oc.tenantId, organizationId: oc.organizationId, userId: oc.userId, role: oc.role };
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
