import debug from 'debug';
import type { PruneResult } from './types.js';

const NS = 'pkg-optimize';

function splitDebugList(): string[] {
  return (process.env.DEBUG ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergePkgOptimizeTags(pkgTags: string[]): void {
  const parts = splitDebugList();
  const withoutPkg = parts.filter(
    (p) => p !== NS && !p.startsWith(`${NS}:`),
  );
  process.env.DEBUG = [...withoutPkg, ...pkgTags].join(',');
  debug.enable(process.env.DEBUG);
}

/** Appends `pkg-optimize:error` so early CLI failures can print before `configureLogging`. */
export function primeErrorDebug(): void {
  const parts = splitDebugList();
  if (
    parts.some(
      (p) =>
        p === `${NS}:error` || p === NS || p === `${NS}:*`,
    )
  ) {
    debug.enable(process.env.DEBUG ?? '');
    return;
  }
  process.env.DEBUG = [...parts, `${NS}:error`].join(',');
  debug.enable(process.env.DEBUG);
}

/**
 * After CLI flags are known: wire `DEBUG` for pkg-optimize namespaces.
 * Unrelated `DEBUG` entries (e.g. `other-lib:trace`) are preserved.
 *
 * - Default: `pkg-optimize:error`, `:warn`, `:info`, `:result`, plus any
 *   existing `pkg-optimize:*` patterns you already had in `DEBUG`.
 * - `--verbose`: `pkg-optimize:*`
 * - `--silent`: `pkg-optimize:error` only
 */
export function configureLogging(opts: {
  verbose?: boolean;
  silent?: boolean;
}): void {
  const parts = splitDebugList();
  const withoutPkg = parts.filter(
    (p) => p !== NS && !p.startsWith(`${NS}:`),
  );
  const existingPkg = parts.filter(
    (p) => p === NS || p.startsWith(`${NS}:`),
  );

  if (opts.silent) {
    process.env.DEBUG = [...withoutPkg, `${NS}:error`].join(',');
    debug.enable(process.env.DEBUG);
    return;
  }
  if (opts.verbose) {
    process.env.DEBUG = [...withoutPkg, `${NS}:*`].join(',');
    debug.enable(process.env.DEBUG);
    return;
  }

  const defaults = [
    `${NS}:error`,
    `${NS}:warn`,
    `${NS}:info`,
    `${NS}:result`,
  ];
  const hasWildcard = existingPkg.some(
    (p) => p === `${NS}:*` || p === NS,
  );
  const mergedPkg = hasWildcard
    ? existingPkg
    : [...new Set([...existingPkg, ...defaults])];
  process.env.DEBUG = [...withoutPkg, ...mergedPkg].join(',');
  debug.enable(process.env.DEBUG);
}

export const dbg = {
  error: debug(`${NS}:error`),
  warn: debug(`${NS}:warn`),
  info: debug(`${NS}:info`),
  result: debug(`${NS}:result`),
  cli: debug(`${NS}:cli`),
  cache: debug(`${NS}:cache`),
  prune: debug(`${NS}:prune`),
  scan: debug(`${NS}:scan`),
  watcher: debug(`${NS}:watcher`),
  summary: debug(`${NS}:summary`),
} as const;

export function logVerboseRunSummary(results: PruneResult[]): void {
  if (results.length === 0) {
    dbg.summary('run complete: no packages processed');
    return;
  }
  let removed = 0;
  let restored = 0;
  let kept = 0;
  let warnCount = 0;
  for (const r of results) {
    removed += r.removed.length;
    restored += r.restored.length;
    kept += r.kept.length;
    warnCount += r.warnings.length;
  }
  dbg.summary('── run summary ──');
  dbg.summary(
    'totals: packages=%d removed=%d restored=%d kept=%d warnings=%d',
    results.length,
    removed,
    restored,
    kept,
    warnCount,
  );
  for (const r of results) {
    dbg.summary(
      '  %s: removed=%d restored=%d kept=%d',
      r.packageName,
      r.removed.length,
      r.restored.length,
      r.kept.length,
    );
    for (const w of r.warnings) dbg.summary('    warn: %s', w);
  }
}

export function formatResultLine(result: PruneResult): string {
  const { packageName, removed, restored, kept } = result;
  const parts: string[] = [packageName, `kept ${kept.length}`];
  if (removed.length) parts.push(`removed ${removed.length}`);
  if (restored.length) parts.push(`restored ${restored.length}`);
  return parts.join(' · ');
}

export function emitResult(result: PruneResult): void {
  dbg.result(formatResultLine(result));
  for (const w of result.warnings) {
    dbg.warn('  warn: %s (%s)', w, result.packageName);
  }
  // Under verbose (`pkg-optimize:*`), list every file we touched so users can
  // see exactly what disappeared from `node_modules` without diffing the cache.
  if (dbg.summary.enabled && result.removed.length) {
    dbg.summary('  removed files (%s):', result.packageName);
    for (const path of result.removed) dbg.summary('    - %s', path);
  }
}
