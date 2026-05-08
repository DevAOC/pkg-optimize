import chokidar from 'chokidar';
import _debounce from 'lodash.debounce';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShakerCache } from './cache.js';
import { loadConfig, writeConfig } from './config.js';
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
}

export async function startWatcher(options: StartWatcherOptions): Promise<() => Promise<void>> {
  const { configPath, projectRoot } = options;
  let { config } = options;

  let resolvedPackages = await resolveAllPackages(config, projectRoot);

  // Prime caches and run an initial prune.
  for (const pkg of resolvedPackages) {
    const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, projectRoot);
    if (!cache.isCached() && cache.livePackageExists()) cache.prime();
    await runPruneForPackage(pkg, projectRoot, 'initial', { soft: pkg.watch.softPruneInDev });
  }

  writeDetectedToConfig(config, resolvedPackages, configPath);

  const packagePruners = new Map<string, ReturnType<typeof debounce>>();
  for (const pkg of resolvedPackages) {
    packagePruners.set(
      pkg.targetPackage,
      debounce((reason: string) => {
        runPruneForPackage(pkg, projectRoot, reason, { soft: pkg.watch.softPruneInDev });
      }, pkg.watch.debounceMs),
    );
  }

  const minDebounce = Math.min(
    ...resolvedPackages.map((p) => p.watch.debounceMs),
    300,
  );
  const allPackagesPruner = debounce(async (reason: string) => {
    log.info(`Re-scanning all packages (${reason})...`);
    for (const pkg of resolvedPackages) {
      await runPruneForPackage(pkg, projectRoot, reason, {
        soft: pkg.watch.softPruneInDev,
      });
    }
  }, minDebounce);

  const packageWatchers: chokidar.FSWatcher[] = [];
  for (const pkg of resolvedPackages) {
    const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, projectRoot);
    const packageDir = resolve(projectRoot, 'node_modules', pkg.targetPackage);
    if (!existsSync(packageDir)) continue;

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
        const reprimed = cache.reprime({ force: fileSetChanged });
        if (reprimed) {
          log.info(`[${pkg.targetPackage}] package changed externally — re-priming cache`);
          packagePruners.get(pkg.targetPackage)?.('package updated');
        }
      });
    packageWatchers.push(watcher);
  }

  const allScanDirs = [
    ...new Set(resolvedPackages.flatMap((p) => p.scanDirs)),
  ]
    .map((d) => resolve(projectRoot, d))
    .filter((d) => existsSync(d));

  const sourceWatcher = chokidar
    .watch(allScanDirs, { ignoreInitial: true, ignored: /node_modules/ })
    .on('all', () => allPackagesPruner('source changed'));

  const configWatcher = chokidar
    .watch(configPath, { ignoreInitial: true })
    .on('change', async () => {
      log.info('Config changed — reloading and re-running all packages...');
      try {
        const next = loadConfig(projectRoot);
        config = next.config;
        resolvedPackages = await resolveAllPackages(config, projectRoot);
        for (const pkg of resolvedPackages) {
          await runPruneForPackage(pkg, projectRoot, 'config changed', {
            soft: pkg.watch.softPruneInDev,
          });
        }
      } catch (err) {
        log.error(`Failed to reload config: ${(err as Error).message}`);
      }
    });

  log.info(
    `Watching ${resolvedPackages.length} package(s) and ${allScanDirs.length} source dir(s)...`,
  );

  return async function stop() {
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
): Promise<void> {
  log.info(`[${pkg.targetPackage}] Re-scanning (${reason})...`);
  const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, projectRoot);
  if (!cache.isCached()) {
    if (cache.livePackageExists()) cache.prime();
    else {
      log.warn(`[${pkg.targetPackage}] package not installed — skipping`);
      return;
    }
  }
  const usageMap = scanDirs(pkg.scanDirs, projectRoot, pkg.patterns, {
    targetPackage: pkg.targetPackage,
  });
  const result = prune({
    usageMap,
    config: pkg,
    sourceDir: cache.getCachedPackageDir(),
    targetDir: cache.getLivePackageDir(),
    soft: opts.soft,
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

function writeDetectedToConfig(
  config: ShakerConfig,
  resolved: ResolvedPackageConfig[],
  configPath: string,
): void {
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
  if (dirty && existsSync(configPath)) writeConfig(updated, configPath);
}
