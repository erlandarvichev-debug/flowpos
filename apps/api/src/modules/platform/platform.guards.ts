import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { runAsSystem } from '../../common/db-context';
import { SOLUTION_NAMES, Solution, solutionState } from './subscriptions';

/** Пользователь — администратор платформы? Служебная таблица читается только в системном режиме. */
export async function isPlatformAdmin(prisma: PrismaService, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = await runAsSystem(() => prisma.platformAdmin.findUnique({ where: { userId }, select: { userId: true } }));
  return !!row;
}

/**
 * Доступ к разделу «Платформа». Применяется после JwtAuthGuard. Администратор платформы — не роль организации:
 * список в таблице platform_admins (скрипт deploy/scripts/platform-admin.mjs).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    if (!(await isPlatformAdmin(this.prisma, req.user?.sub))) throw new ForbiddenException('Раздел только для администратора платформы');
    return true;
  }
}

export const REQUIRE_SOLUTION = 'platform:solution';
/** Адрес доступен только организации с подключённым решением. Ставится вместе с OrgGuard (после него). */
export const RequireSolution = (s: Solution) => SetMetadata(REQUIRE_SOLUTION, s);

/** Проверка подписки организации запроса (организацию уже определил OrgGuard). */
@Injectable()
export class SolutionGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const solution = this.reflector.getAllAndOverride<Solution>(REQUIRE_SOLUTION, [ctx.getHandler(), ctx.getClass()]);
    if (!solution) return true;
    const organizationId = ctx.switchToHttp().getRequest().orgContext?.organizationId;
    if (!organizationId) throw new ForbiddenException('Нет проверенного доступа к организации');
    await assertSolution(this.prisma, organizationId, solution);
    return true;
  }
}

/** Отказ с понятным текстом, если решение у организации не подключено, приостановлено или срок истёк. */
export async function assertSolution(prisma: PrismaService, organizationId: string, solution: Solution) {
  const row = await prisma.orgSubscription.findUnique({ where: { organizationId_solution: { organizationId, solution } } });
  const state = solutionState(solution, row);
  if (!state.enabled) throw new ForbiddenException(`Решение «${SOLUTION_NAMES[solution]}» недоступно: ${state.reason}`);
  return state;
}
