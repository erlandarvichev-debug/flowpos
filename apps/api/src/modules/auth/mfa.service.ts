import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  base32Encode, decryptSecret, encryptSecret, matchRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp,
} from './mfa';

/** Неверных кодов подряд до блокировки второго фактора и её длительность. */
export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_MS = 15 * 60_000;

const fail = (code: string, message: string) => new UnauthorizedException({ code, message });

/** FP-008: второй фактор пользователя — подключение, проверка кода (с защитой от перебора и повтора), отключение. */
@Injectable()
export class MfaService {
  constructor(private prisma: PrismaService) {}

  /**
   * Проверить код TOTP или одноразовый код восстановления включённой MFA.
   * Принятый шаг TOTP запоминается (повтор кода отвергается), код восстановления сгорает,
   * 5 неверных кодов подряд блокируют второй фактор на 15 минут.
   */
  async checkCode(userId: string, code: string, opts: { pending?: boolean } = {}): Promise<'totp' | 'recovery'> {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || !u.isActive) throw fail('MFA_INVALID', 'Неверный код');
    if (!u.mfaSecretEnc || (!opts.pending && !u.mfaEnabledAt)) throw fail('MFA_NOT_ENABLED', 'Второй фактор не подключён');
    if (u.mfaLockedUntil && u.mfaLockedUntil > new Date()) {
      throw fail('MFA_LOCKED', `Слишком много неверных кодов — попробуйте после ${u.mfaLockedUntil.toISOString().slice(11, 16)} UTC`);
    }
    const input = String(code ?? '').trim();
    const step = verifyTotp(decryptSecret(u.mfaSecretEnc), input, u.mfaLastStep);
    if (step != null) {
      // Условно: из двух одновременных запросов с одним кодом проходит один.
      const { count } = await this.prisma.user.updateMany({
        where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
        data: { mfaLastStep: step, mfaFailedCount: 0, mfaLockedUntil: null },
      });
      if (count === 1) return 'totp';
    } else if (!opts.pending) {
      const idx = matchRecoveryCode(input, u.mfaRecoveryCodes);
      if (idx >= 0) {
        const rest = u.mfaRecoveryCodes.filter((_, i) => i !== idx);
        const { count } = await this.prisma.user.updateMany({
          where: { id: userId, mfaRecoveryCodes: { has: u.mfaRecoveryCodes[idx] } },
          data: { mfaRecoveryCodes: rest, mfaFailedCount: 0, mfaLockedUntil: null },
        });
        if (count === 1) return 'recovery';
      }
    }
    const failed = u.mfaFailedCount + 1;
    await this.prisma.user.update({
      where: { id: userId },
      data: failed >= MFA_MAX_FAILURES ? { mfaFailedCount: 0, mfaLockedUntil: new Date(Date.now() + MFA_LOCK_MS) } : { mfaFailedCount: failed },
    });
    throw fail('MFA_INVALID', 'Неверный код');
  }

  /** Начать подключение: новый секрет (до подтверждения кодом MFA не включена). */
  async setup(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.mfaEnabledAt) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Второй фактор уже подключён' });
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaSecretEnc: encryptSecret(secret), mfaLastStep: null, mfaFailedCount: 0 } });
    const b32 = base32Encode(secret);
    return { secret: b32, otpauthUrl: otpauthUri(b32, u.email) };
  }

  /** Подтвердить подключение кодом из приложения: MFA включается, текущая сессия считается подтверждённой. */
  async enable(userId: string, sessionId: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.mfaEnabledAt) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Второй фактор уже подключён' });
    await this.checkCode(userId, code, { pending: true });
    const { plain, hashed } = newRecoveryCodes();
    const now = new Date();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabledAt: now, mfaRecoveryCodes: hashed } });
    await this.prisma.authSession.update({ where: { id: sessionId }, data: { mfaAt: now } });
    await this.prisma.auditLog.create({ data: { userId, organizationId: u.organizationId, action: 'MFA_ENABLED', entity: 'User', entityId: userId } });
    return { enabled: true, recoveryCodes: plain };
  }

  /** Отключить: нужен действующий код. Остальные сессии завершаются — их подтверждение вторым фактором больше не значит ничего. */
  async disable(userId: string, sessionId: string, code: string) {
    await this.checkCode(userId, code);
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, mfaRecoveryCodes: [], mfaFailedCount: 0, mfaLockedUntil: null },
    });
    await this.prisma.authSession.updateMany({ where: { userId }, data: { mfaAt: null } });
    await this.prisma.auditLog.create({ data: { userId, organizationId: u.organizationId, action: 'MFA_DISABLED', entity: 'User', entityId: userId } });
    return { enabled: false };
  }

  /** Подтвердить вторым фактором текущую сессию (для привилегированных операций). */
  async stepUp(userId: string, sessionId: string, code: string) {
    const how = await this.checkCode(userId, code);
    const mfaAt = new Date();
    await this.prisma.authSession.update({ where: { id: sessionId }, data: { mfaAt } });
    return { mfaAt, method: how };
  }

  /** Новые коды восстановления (старые перестают действовать). Нужен действующий код. */
  async regenerateRecovery(userId: string, code: string) {
    await this.checkCode(userId, code);
    const { plain, hashed } = newRecoveryCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: hashed } });
    return { recoveryCodes: plain };
  }

  /** Привилегированная операция требует сессию, подтверждённую вторым фактором. */
  static requireStepUp(mfaAt: Date | null | undefined) {
    if (!mfaAt) {
      throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Операция требует второго фактора: подключите его и подтвердите вход кодом' });
    }
  }
}
