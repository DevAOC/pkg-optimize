import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isAbortError, pathExists, withSignal } from './utils.js';

export class ShakerCache {
  private readonly packageDir: string;
  private readonly cachedPackageDir: string;
  /**
   * Serialize mutating operations (`prime` / `reprime`). The sync `*Sync` APIs
   * the watcher used to call were naturally serialized by Node's single
   * thread; with async APIs, two chokidar events firing in quick succession
   * could otherwise interleave `rm` + `cp` and corrupt the cache.
   */
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(cacheBaseDir: string, targetPackage: string, projectRoot: string) {
    this.packageDir = resolve(projectRoot, 'node_modules', targetPackage);
    this.cachedPackageDir = resolve(projectRoot, cacheBaseDir, targetPackage);
  }

  isCached(): Promise<boolean> {
    return pathExists(this.cachedPackageDir);
  }

  livePackageExists(): Promise<boolean> {
    return pathExists(this.packageDir);
  }

  /** Copy the live package into cache. Called on first run. */
  prime(opts?: { signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal;
    return this.enqueue(async () => {
      opts?.signal?.throwIfAborted();
      if (!(await pathExists(this.packageDir, signal))) {
        throw new Error(
          `Cannot prime cache: package not found at ${this.packageDir}. Has it been installed?`,
        );
      }
      await withSignal(signal, () =>
        mkdir(this.cachedPackageDir, { recursive: true }),
      );
      await withSignal(signal, () =>
        cp(this.packageDir, this.cachedPackageDir, {
          recursive: true,
          force: true,
          // `node_modules/<pkg>` is often a symlink (pnpm, hoists). Without
          // dereferencing, `cp` treats the symlink as a non-directory source
          // and fails with ERR_FS_CP_NON_DIR_TO_DIR after we mkdir the dest.
          dereference: true,
        }),
      );
    });
  }

  /**
   * Re-prime when the package has changed externally. Returns `true` if a
   * re-copy happened, `false` if nothing changed.
   *
   * By default this uses a fast mtime check on `package.json`, which is the
   * right signal for "the package was reinstalled" (npm/yarn always rewrites
   * `package.json` on install). Pass `{ force: true }` to bypass that check —
   * the watcher uses this when chokidar reports an `add`/`unlink` event,
   * because tools like `ggt`, graphql-codegen, etc. regenerate files inside
   * a linked package without touching its `package.json`.
   */
  reprime(opts?: { force?: boolean; signal?: AbortSignal }): Promise<boolean> {
    const signal = opts?.signal;
    return this.enqueue(async () => {
      opts?.signal?.throwIfAborted();
      if (!(await pathExists(this.packageDir, signal))) return false;

      if (!opts?.force) {
        const livePkgJson = resolve(this.packageDir, 'package.json');
        const cachedPkgJson = resolve(this.cachedPackageDir, 'package.json');

        let liveMtime = 0;
        let cacheMtime = 0;
        try {
          liveMtime = (await withSignal(signal, () => stat(livePkgJson))).mtimeMs;
        } catch (err) {
          if (isAbortError(err)) throw err;
          return false;
        }
        try {
          cacheMtime = (await withSignal(signal, () => stat(cachedPkgJson))).mtimeMs;
        } catch (err) {
          if (isAbortError(err)) throw err;
          cacheMtime = 0;
        }

        if (liveMtime <= cacheMtime) return false;
      }

      await withSignal(signal, () =>
        rm(this.cachedPackageDir, { recursive: true, force: true }),
      );
      await withSignal(signal, () =>
        mkdir(this.cachedPackageDir, { recursive: true }),
      );
      await withSignal(signal, () =>
        cp(this.packageDir, this.cachedPackageDir, {
          recursive: true,
          force: true,
          dereference: true,
        }),
      );
      return true;
    });
  }

  getCachedPackageDir(): string {
    return this.cachedPackageDir;
  }

  getLivePackageDir(): string {
    return this.packageDir;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.inflight.then(op, op);
    // Swallow rejections on the chain so a single failure doesn't poison
    // every subsequent operation; the caller still sees the rejection.
    this.inflight = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
