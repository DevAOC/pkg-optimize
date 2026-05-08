import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export class ShakerCache {
  private readonly packageDir: string;
  private readonly cachedPackageDir: string;

  constructor(cacheBaseDir: string, targetPackage: string, projectRoot: string) {
    this.packageDir = resolve(projectRoot, 'node_modules', targetPackage);
    this.cachedPackageDir = resolve(projectRoot, cacheBaseDir, targetPackage);
  }

  isCached(): boolean {
    return existsSync(this.cachedPackageDir);
  }

  livePackageExists(): boolean {
    return existsSync(this.packageDir);
  }

  /** Copy the live package into cache. Called on first run. */
  prime(): void {
    if (!this.livePackageExists()) {
      throw new Error(
        `Cannot prime cache: package not found at ${this.packageDir}. Has it been installed?`,
      );
    }
    mkdirSync(this.cachedPackageDir, { recursive: true });
    cpSync(this.packageDir, this.cachedPackageDir, {
      recursive: true,
      force: true,
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
  reprime(opts?: { force?: boolean }): boolean {
    if (!this.livePackageExists()) return false;

    if (!opts?.force) {
      const livePkgJson = resolve(this.packageDir, 'package.json');
      const cachedPkgJson = resolve(this.cachedPackageDir, 'package.json');

      let liveMtime = 0;
      let cacheMtime = 0;
      try {
        liveMtime = statSync(livePkgJson).mtimeMs;
      } catch {
        return false;
      }
      try {
        cacheMtime = statSync(cachedPkgJson).mtimeMs;
      } catch {
        cacheMtime = 0;
      }

      if (liveMtime <= cacheMtime) return false;
    }

    rmSync(this.cachedPackageDir, { recursive: true, force: true });
    mkdirSync(this.cachedPackageDir, { recursive: true });
    cpSync(this.packageDir, this.cachedPackageDir, {
      recursive: true,
      force: true,
    });
    return true;
  }

  getCachedPackageDir(): string {
    return this.cachedPackageDir;
  }

  getLivePackageDir(): string {
    return this.packageDir;
  }
}
