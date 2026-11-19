/**
 * Tiny leveled logger. In JSON mode it emits newline-delimited JSON records so
 * CI systems and future dashboards can consume logs machine-readably.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 100,
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
};

export type LogEvent = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  error(message: string, event?: LogEvent): void;
  warn(message: string, event?: LogEvent): void;
  info(message: string, event?: LogEvent): void;
  debug(message: string, event?: LogEvent): void;
  child(bindings: LogEvent): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  /** Any writable with `write`. Defaults to stdout for info/debug, stderr for error/warn. */
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  bindings?: LogEvent;
}

const ICONS: Record<'error' | 'warn' | 'info' | 'debug', string> = {
  error: '✖',
  warn: '▲',
  info: '●',
  debug: '·',
};

function createInner(options: LoggerOptions, bindings: LogEvent): Logger {
  const level = options.level ?? 'info';
  const json = options.json ?? false;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const emit = (
    entryLevel: 'error' | 'warn' | 'info' | 'debug',
    message: string,
    event?: LogEvent,
  ): void => {
    if (LEVEL_WEIGHT[entryLevel] < LEVEL_WEIGHT[level]) return;
    const stream = entryLevel === 'error' || entryLevel === 'warn' ? stderr : stdout;
    if (json) {
      const record = {
        time: new Date().toISOString(),
        level: entryLevel,
        msg: message,
        ...bindings,
        ...event,
      };
      stream.write(`${JSON.stringify(record)}\n`);
    } else {
      const prefix = `${ICONS[entryLevel]} `;
      stream.write(`${prefix}${message}\n`);
    }
  };

  return {
    level,
    error: (message, event) => emit('error', message, event),
    warn: (message, event) => emit('warn', message, event),
    info: (message, event) => emit('info', message, event),
    debug: (message, event) => emit('debug', message, event),
    child: (extra) => createInner(options, { ...bindings, ...extra }),
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return createInner(options, options.bindings ?? {});
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
