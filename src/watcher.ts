import chokidar from 'chokidar';
import _debounce from 'lodash.debounce';
import { resolve } from 'node:path';
import { ShakerCache } from './cache.js';
import { loadConfig, writeConfig } from './config.js';
import { pathExists } from './utils.js';
import { log } from './logger.js';
import { prune } from './pruner.js';
import { resolvePackageConfig } from './resolver.js';
import { scanDirs } from './scanner.js';
import type { ResolvedPackageConfig, ShakerConfig } from './types.js';

const debounce: typeof _debounce =
  (_debounce as unknown as { default?: typeof _debounce }).default ?? _debounce;

export interface StartWatcherOptions {
  config: ShakerConfig;
  configPath: string;
  projectRoot: string;
  /** Cooperative cancellation for shutdown (SIGINT / SIGTERM / API). */
  signal?: AbortSignal;
}

export async function startWatcher(options: StartWatcherOptions): Promise<() => Promise<void>> {
  const { configPath, projectRoot, signal } = options;
  let { config } = options;

  let resolvedPackages = await resolveAllPackages(config, projectRoot);

  // Prime caches and run an initial prune.
  for (const pkg of resolvedPackages) {
    signal?.throwIfAborted();
    const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, projectRoot);
    if (!(await cache.isCached()) && (await cache.livePackageExists())) {
      await cache.prime({ signal });
    }
    await runPruneForPackage(pkg, projectRoot, 'initial', { soft: pkg.watch.softPruneInDev }, signal);
  }

  await writeDetectedToConfig(config, resolvedPackages, configPath, signal);

  const packagePruners = new Map<string, ReturnType<typeof debounce>>();
  for (const pkg of resolvedPackages) {
    packagePruners.set(
      pkg.targetPackage,
      debounce((reason: string) => {
        void (async () => {
          try {
            await runPruneForPackage(pkg, projectRoot, reason, { soft: pkg.watch.softPruneInDev }, signal);
          } catch (err) {
            log.error(`[${pkg.targetPackage}] prune failed: ${(err as Error).message}`);
          }
        })();
      }, pkg.watch.debounceMs),
    );
  }

  const minDebounce = Math.min(
    ...resolvedPackages.map((p) => p.watch.debounceMs),
    300,
  );
  const allPackagesPruner = debounce(async (reason: string) => {
    signal?.throwIfAborted();
    log.info(`Re-scanning all packages (${reason})...`);
    for (const pkg of resolvedPackages) {
      signal?.throwIfAborted();
      await runPruneForPackage(pkg, projectRoot, reason, {
        soft: pkg.watch.softPruneInDev,
      }, signal);
    }
  }, minDebounce);

  const packageWatchers: chokidar.FSWatcher[] = [];
  for (const pkg of resolvedPackages) {
    const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, projectRoot);
    const packageDir = resolve(projectRoot, 'node_modules', pkg.targetPackage);
    if (!(await pathExists(packageDir, signal))) continue;

    const watcher = chokidar
      .watch(packageDir, { ignoreInitial: true, ignored: /\.pkg-optimize-cache/ })
      .on('all', (event) => {
        // `add`/`unlink`/`addDir`/`unlinkDir` mean the file *set* changed —
        // the only thing the pruner cares about. That's the signal a tool
        // like `ggt` or graphql-codegen produces when it regenerates a model
        // inside a linked package, *without* bumping `package.json`'s mtime.
        // `change` is an in-place content edit and the existing fast path
        // (mtime on `package.json`) is fine for that case.
        const fileSetChanged =
          event === 'add' ||
          event === 'unlink' ||
          event === 'addDir' ||
          event === 'unlinkDir';
        // `ShakerCache` serializes its own operations internally, so racing
        // chokidar events can't interleave `rm` + `cp` and corrupt the cache.
        void (async () => {
          try {
            const reprimed = await cache.reprime({ force: fileSetChanged, signal });
            if (reprimed) {
              log.info(
                `[${pkg.targetPackage}] package changed externally — re-priming cache`,
              );
              packagePruners.get(pkg.targetPackage)?.('package updated');
            }
          } catch (err) {
            log.error(
              `[${pkg.targetPackage}] cache reprime failed: ${(err as Error).message}`,
            );
          }
        })();
      });
    packageWatchers.push(watcher);
  }

  const candidateScanDirs = [
    ...new Set(resolvedPackages.flatMap((p) => p.scanDirs)),
  ].map((d) => resolve(projectRoot, d));
  const scanDirExistence = await Promise.all(
    candidateScanDirs.map((d) => pathExists(d, signal)),
  );
  const allScanDirs = candidateScanDirs.filter((_, i) => scanDirExistence[i]);

  const sourceWatcher = chokidar
    .watch(allScanDirs, { ignoreInitial: true, ignored: /node_modules/ })
    .on('all', () => allPackagesPruner('source changed'));

  const configWatcher = chokidar
    .watch(configPath, { ignoreInitial: true })
    .on('change', async () => {
      if (signal?.aborted) return;
      log.info('Config changed — reloading and re-running all packages...');
      try {
        const next = await loadConfig(projectRoot);
        config = next.config;
        resolvedPackages = await resolveAllPackages(config, projectRoot);
        for (const pkg of resolvedPackages) {
          signal?.throwIfAborted();
          await runPruneForPackage(pkg, projectRoot, 'config changed', {
            soft: pkg.watch.softPruneInDev,
          }, signal);
        }
      } catch (err) {
        log.error(`Failed to reload config: ${(err as Error).message}`);
      }
    });

  log.info(
    `Watching ${resolvedPackages.length} package(s) and ${allScanDirs.length} source dir(s)...`,
  );

  return async function stop() {
    for (const d of packagePruners.values()) d.cancel();
    allPackagesPruner.cancel();
    await Promise.all(packageWatchers.map((w) => w.close()));
    await sourceWatcher.close();
    await configWatcher.close();
  };
}

async function runPruneForPackage(
  pkg: ResolvedPackageConfig,
  projectRoot: string,
  reason: string,
  opts: { soft: boolean },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  log.info(`[${pkg.targetPackage}] Re-scanning (${reason})...`);
  const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, projectRoot);
  if (!(await cache.isCached())) {
    if (await cache.livePackageExists()) {
      await cache.prime({ signal });
    } else {
      log.warn(`[${pkg.targetPackage}] package not installed — skipping`);
      return;
    }
  }
  const usageMap = await scanDirs(pkg.scanDirs, projectRoot, pkg.patterns, {
    targetPackage: pkg.targetPackage,
    signal,
  });
  const result = await prune({
    usageMap,
    config: pkg,
    sourceDir: cache.getCachedPackageDir(),
    targetDir: cache.getLivePackageDir(),
    soft: opts.soft,
    signal,
  });
  log.result(result);
}

async function resolveAllPackages(
  config: ShakerConfig,
  projectRoot: string,
): Promise<ResolvedPackageConfig[]> {
  return Promise.all(
    config.packages.map((pkg) => resolvePackageConfig(pkg, config, projectRoot)),
  );
}

async function writeDetectedToConfig(
  config: ShakerConfig,
  resolved: ResolvedPackageConfig[],
  configPath: string,
  signal?: AbortSignal,
): Promise<void> {
  let dirty = false;
  const updated = {
    ...config,
    packages: config.packages.map((pkg, i) => {
      if (!pkg._detected && resolved[i]?._detected) {
        dirty = true;
        return { ...pkg, _detected: resolved[i]!._detected };
      }
      return pkg;
    }),
  };
  if (dirty && (await pathExists(configPath, signal))) {
    await writeConfig(updated, configPath);
  }
}
