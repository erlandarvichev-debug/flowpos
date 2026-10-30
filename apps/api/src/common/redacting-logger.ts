import { ConsoleLogger } from '@nestjs/common';
import { redact } from './redact';
import { currentDbContext } from './db-context';

/**
 * FP-022: глобальный логгер Nest — каждое сообщение маскируется (redact) и помечается кодом трассировки
 * текущего запроса/задачи, чтобы строку лога можно было связать с действием в интерфейсе и записью журнала.
 */
export class RedactingLogger extends ConsoleLogger {
  protected formatMessage(logLevel: any, message: unknown, pidMessage: string, formattedLogLevel: string, contextMessage: string, timestampDiff: string) {
    const trace = currentDbContext().traceId;
    const text = redact(message instanceof Error ? (message.stack ?? message.message) : message);
    return super.formatMessage(logLevel, trace ? `[trace ${trace}] ${text}` : text, pidMessage, formattedLogLevel, redact(contextMessage), timestampDiff);
  }

  protected printStackTrace(stack: string) {
    super.printStackTrace(redact(stack));
  }
}
