import { stat } from 'node:fs/promises';

/**
 * Shared helpers for cooperative cancellation (SIGINT / SIGTERM / programmatic
 * shutdown) via {@link AbortSignal}.
 */
export function isAbortError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name: string }).name === 'AbortError'
  );
}

/**
 * Runs an `fs/promises` (or other) async callback while respecting
 * {@link AbortSignal}: abort is checked before and after the operation.
 *
 * Node's `stat` / `mkdir` / `readdir` / etc. do not accept `signal` on their
 * option objects; wrapping is the correct way to cooperate with shutdown.
 */
export async function withSignal<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const result = await fn();
  signal?.throwIfAborted();
  return result;
}

/**
 * Async replacements for the small subset of `existsSync`-style checks we use
 * across the codebase. We deliberately catch any error (ENOENT, EACCES, etc.)
 * and return `false` — every caller already treats "can't stat" as "missing".
 * When `signal` aborts, {@link AbortError} is rethrown so shutdown can propagate.
 */
export async function pathExists(p: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await withSignal(signal, () => stat(p));
    return true;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return false;
  }
}

export async function isDirectory(p: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return (await withSignal(signal, () => stat(p))).isDirectory();
  } catch (err) {
    if (isAbortError(err)) throw err;
    return false;
  }
}

export async function isFile(p: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return (await withSignal(signal, () => stat(p))).isFile();
  } catch (err) {
    if (isAbortError(err)) throw err;
    return false;
  }
}
