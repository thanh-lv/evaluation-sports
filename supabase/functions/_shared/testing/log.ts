/** A logger that keeps parsed lines in memory, for asserting on logs. */
import { createLogger, type Logger, type LogLevel } from '../log.ts';

export interface CapturedLine {
  level: LogLevel;
  raw: string;
  entry: Record<string, unknown>;
}

export function captureLogger(level: LogLevel = 'debug'): { log: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const log = createLogger({}, {
    level,
    sink: (lvl, raw) => lines.push({ level: lvl, raw, entry: JSON.parse(raw) as Record<string, unknown> }),
  });
  return { log, lines };
}
