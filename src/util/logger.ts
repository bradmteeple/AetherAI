export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(prefix: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? ((process.env.LOG_LEVEL as LogLevel) || 'info');
  const threshold = LEVELS[level] ?? LEVELS.info;
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const prefix = options.prefix ? `[${options.prefix}] ` : '';

  function emit(kind: LogLevel, msg: string, meta?: unknown) {
    if (LEVELS[kind] < threshold) return;
    const ts = new Date().toISOString();
    let line = `${ts} ${kind.toUpperCase().padEnd(5)} ${prefix}${msg}`;
    if (meta !== undefined) {
      try {
        line += ' ' + (typeof meta === 'string' ? meta : JSON.stringify(meta));
      } catch {
        line += ' [unserializable meta]';
      }
    }
    sink(line);
  }

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (childPrefix: string) =>
      createLogger({ level, sink, prefix: options.prefix ? `${options.prefix}:${childPrefix}` : childPrefix }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
