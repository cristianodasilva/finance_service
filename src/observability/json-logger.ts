import type { LoggerService, LogLevel } from '@nestjs/common';
import { currentLogContext } from './log-context';

/**
 * Logger que escreve UMA LINHA JSON por evento, por exemplo:
 *   {"time":"...","level":"info","context":"WagerQueueConsumer","message":"...","correlationId":"..."}
 *
 * JSON é fácil de ser lido por ferramentas (Datadog, Loki, CloudWatch...),
 * que permitem filtrar por campo: level=error, walletId=X, etc.
 *
 * Regra: NUNCA logar payloads financeiros completos (corpo da requisição, dados do jogador).
 * Logamos apenas ids, status e códigos.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly minLevel: LogLevel = 'log') {}

  private static readonly ORDER: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
  private static readonly NAMES: Record<LogLevel, string> = {
    verbose: 'trace',
    debug: 'debug',
    log: 'info',
    warn: 'warn',
    error: 'error',
    fatal: 'fatal',
  };

  log(message: unknown, ...optional: unknown[]) {
    this.write('log', message, optional);
  }
  error(message: unknown, ...optional: unknown[]) {
    this.write('error', message, optional);
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.write('warn', message, optional);
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.write('debug', message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.write('verbose', message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]) {
    this.write('fatal', message, optional);
  }

  private write(level: LogLevel, message: unknown, optional: unknown[]): void {
    if (JsonLogger.ORDER.indexOf(level) < JsonLogger.ORDER.indexOf(this.minLevel)) return;
    // O Nest passa o "contexto" (nome da classe) como último argumento.
    const context = typeof optional[optional.length - 1] === 'string' ? optional.pop() : undefined;
    const stack = level === 'error' && typeof optional[0] === 'string' ? optional[0] : undefined;

    const line = {
      time: new Date().toISOString(),
      level: JsonLogger.NAMES[level],
      context,
      message: message instanceof Error ? message.message : message,
      ...currentLogContext(),
      ...(stack ? { stack } : {}),
    };
    const out = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  }
}
