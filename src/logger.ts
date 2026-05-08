import pc from 'picocolors';
import type { PruneResult } from './types.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

let currentLevel: LogLevel = (process.env.PKG_OPTIMIZE_LOG_LEVEL as LogLevel) ?? 'info';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_PRIORITY[currentLevel] >= LEVEL_PRIORITY[level];
}

export const log = {
  setLevel(level: LogLevel) {
    currentLevel = level;
  },
  getLevel(): LogLevel {
    return currentLevel;
  },
  info(message: string) {
    if (shouldLog('info')) console.log(`${pc.cyan('[pkg-optimize]')} ${message}`);
  },
  warn(message: string) {
    if (shouldLog('warn')) console.warn(`${pc.yellow('[pkg-optimize]')} ${pc.yellow(message)}`);
  },
  error(message: string) {
    if (shouldLog('error')) console.error(`${pc.red('[pkg-optimize]')} ${pc.red(message)}`);
  },
  debug(message: string) {
    if (shouldLog('debug')) console.log(`${pc.gray('[pkg-optimize:debug]')} ${pc.gray(message)}`);
  },
  result(result: PruneResult) {
    if (!shouldLog('info')) return;
    const { packageName, removed, restored, kept, warnings } = result;
    const parts: string[] = [];
    parts.push(pc.bold(packageName));
    parts.push(`${pc.green(`kept ${kept.length}`)}`);
    if (removed.length) parts.push(pc.red(`removed ${removed.length}`));
    if (restored.length) parts.push(pc.cyan(`restored ${restored.length}`));
    console.log(`${pc.cyan('[pkg-optimize]')} ${parts.join(' · ')}`);
    for (const w of warnings) {
      console.warn(`  ${pc.yellow('warn:')} ${w}`);
    }
  },
};
