import { pino } from 'pino';

const ALLOW = new Set(['profile', 'operation', 'method', 'pathTemplate', 'status', 'durationMs', 'bytes', 'kind', 'traceId', 'expiresInS', 'scopesCount', 'customerCountry']);
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

export type Logger = { [L in (typeof LEVELS)[number]]: (obj?: object, msg?: string) => void } & { droppedKeys: number };

/** pino behind a key allowlist: anything not listed is dropped (and counted), so a new field can never leak by accident. */
export function createLogger(opts: { level?: string; destination?: { write(chunk: string): void } } = {}): Logger {
  const p = pino({ name: 'stralfors-client', level: opts.level ?? 'info' }, opts.destination);
  const log = { droppedKeys: 0 } as Logger;
  for (const l of LEVELS) {
    log[l] = (obj = {}, msg) => {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (ALLOW.has(k)) clean[k] = v;
        else log.droppedKeys++;
      }
      p[l](clean, msg);
    };
  }
  return log;
}
