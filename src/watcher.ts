import chokidar from "chokidar";
import _debounce from "lodash.debounce";
import { resolve } from "node:path";
import { ShakerCache } from "./cache";
import { loadConfig } from "./config";
import {
  buildDetectedSnapshot,
  detectedSnapshotPath,
  writeDetectedSnapshot,
} from "./detector";
import { pathExists } from "./utils";
import { dbg, emitResult } from "./logger";
import { prune } from "./pruner";
import { resolvePackageConfig } from "./resolver";
import { scanDirs } from "./scanner";
import type { ResolvedPackageConfig, ShakerConfig } from "./types";

const debounce: typeof _debounce =
  (_debounce as unknown as { default?: typeof _debounce }).default ?? _debounce;

export interface StartWatcherOptions {
  config: ShakerConfig;
  configPath: string;
  projectRoot: string;
  /** Cooperative cancellation for shutdown (SIGINT / SIGTERM / API). */
  signal?: AbortSignal;
}

export async function startWatcher(
  options: StartWatcherOptions
): Promise<() => Promise<void>> {
  const { configPath, projectRoot, signal } = options;
  let { config } = options;

  dbg.watcher(
    "starting watcher for %d configured package(s)",
    config.packages.length
  );

  let resolvedPackages = await resolveAllPackages(config, projectRoot);

  // Prime caches and run an initial prune.
  for (const pkg of resolvedPackages) {
    signal?.throwIfAborted();
    if (pkg.detected.skip) continue;
    const cache = new ShakerCache(
      pkg.cache.dir,
      pkg.target,
      projectRoot
    );
    if (!(await cache.isCached()) && (await cache.livePackageExists())) {
      await cache.prime({ signal });
    }
    await runPruneForPackage(
      pkg,
      projectRoot,
      "initial",
      { soft: pkg.watch.softPruneInDev },
      signal
    );
  }

  await persistDetectedSnapshot(resolvedPackages, projectRoot);

  const packagePruners = new Map<string, ReturnType<typeof debounce>>();
  for (const pkg of resolvedPackages) {
    if (pkg.detected.skip) continue;
    packagePruners.set(
      pkg.target,
      debounce((reason: string) => {
        void (async () => {
          try {
            await runPruneForPackage(
              pkg,
              projectRoot,
              reason,
              { soft: pkg.watch.softPruneInDev },
              signal
            );
          } catch (err) {
            dbg.error(
              `[${pkg.target}] prune failed: ${(err as Error).message}`
            );
          }
        })();
      }, pkg.watch.debounceMs)
    );
  }

  const activePackages = resolvedPackages.filter((p) => !p.detected.skip);
  const minDebounce =
    activePackages.length > 0
      ? Math.min(...activePackages.map((p) => p.watch.debounceMs), 300)
      : 300;
  const allPackagesPruner = debounce(async (reason: string) => {
    signal?.throwIfAborted();
    dbg.info(`Re-scanning all packages (${reason})...`);
    for (const pkg of resolvedPackages) {
      signal?.throwIfAborted();
      await runPruneForPackage(
        pkg,
        projectRoot,
        reason,
        {
          soft: pkg.watch.softPruneInDev,
        },
        signal
      );
    }
  }, minDebounce);

  const packageWatchers: chokidar.FSWatcher[] = [];
  for (const pkg of resolvedPackages) {
    if (pkg.detected.skip) continue;
    const cache = new ShakerCache(
      pkg.cache.dir,
      pkg.target,
      projectRoot
    );
    const packageDir = resolve(projectRoot, "node_modules", pkg.target);
    if (!(await pathExists(packageDir, signal))) continue;

    const watcher = chokidar
      .watch(packageDir, {
        ignoreInitial: true,
        ignored: /\.pkg-optimize-cache/,
      })
      .on("all", (event) => {
        // `add`/`unlink`/`addDir`/`unlinkDir` mean the file *set* changed —
        // the only thing the pruner cares about. That's the signal a tool
        // like `ggt` or graphql-codegen produces when it regenerates a model
        // inside a linked package, *without* bumping `package.json`'s mtime.
        // `change` is an in-place content edit and the existing fast path
        // (mtime on `package.json`) is fine for that case.
        const fileSetChanged =
          event === "add" ||
          event === "unlink" ||
          event === "addDir" ||
          event === "unlinkDir";
        // `ShakerCache` serializes its own operations internally, so racing
        // chokidar events can't interleave `rm` + `cp` and corrupt the cache.
        void (async () => {
          try {
            const reprimed = await cache.reprime({
              force: fileSetChanged,
              signal,
            });
            if (reprimed) {
              dbg.watcher(
                "[%s] live package file set changed — reprimed cache, scheduling prune",
                pkg.target
              );
              dbg.info(
                `[${pkg.target}] package changed externally — re-priming cache`
              );
              packagePruners.get(pkg.target)?.("package updated");
            }
          } catch (err) {
            dbg.error(
              `[${pkg.target}] cache reprime failed: ${
                (err as Error).message
              }`
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
    candidateScanDirs.map((d) => pathExists(d, signal))
  );
  const allScanDirs = candidateScanDirs.filter((_, i) => scanDirExistence[i]);

  const sourceWatcher = chokidar
    .watch(allScanDirs, { ignoreInitial: true, ignored: /node_modules/ })
    .on("all", () => allPackagesPruner("source changed"));

  const configWatcher = chokidar
    .watch(configPath, { ignoreInitial: true })
    .on("change", async () => {
      if (signal?.aborted) return;
      dbg.info("Config changed — reloading and re-running all packages...");
      try {
        const next = await loadConfig(projectRoot);
        config = next.config;
        resolvedPackages = await resolveAllPackages(config, projectRoot);
        await persistDetectedSnapshot(resolvedPackages, projectRoot);
        for (const pkg of resolvedPackages) {
          signal?.throwIfAborted();
          await runPruneForPackage(
            pkg,
            projectRoot,
            "config changed",
            {
              soft: pkg.watch.softPruneInDev,
            },
            signal
          );
        }
      } catch (err) {
        dbg.error(`Failed to reload config: ${(err as Error).message}`);
      }
    });

  dbg.info(
    `Watching ${resolvedPackages.length} package(s) and ${allScanDirs.length} source dir(s)...`
  );
  dbg.watcher(
    "watch roots: packages=%s scanDirs=%s config=%s",
    resolvedPackages.map((p) => p.target).join(", "),
    allScanDirs.join(", "),
    configPath
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
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  if (pkg.detected.skip) {
    dbg.watcher("[%s] skip: could not resolve package entry", pkg.target);
    dbg.warn(`[${pkg.target}] could not resolve package entry — skipping`);
    return;
  }
  dbg.info(`[${pkg.target}] Re-scanning (${reason})...`);
  dbg.watcher(
    "[%s] prune run reason=%s soft=%s",
    pkg.target,
    reason,
    String(opts.soft)
  );
  const cache = new ShakerCache(pkg.cache.dir, pkg.target, projectRoot);
  if (!(await cache.isCached())) {
    if (await cache.livePackageExists()) {
      await cache.prime({ signal });
    } else {
      dbg.watcher("[%s] skip: package not installed", pkg.target);
      dbg.warn(`[${pkg.target}] package not installed — skipping`);
      return;
    }
  }
  const usageMap = await scanDirs(pkg.scanDirs, projectRoot, pkg.patterns, {
    target: pkg.target,
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
  emitResult(result);
}

async function resolveAllPackages(
  config: ShakerConfig,
  projectRoot: string
): Promise<ResolvedPackageConfig[]> {
  return Promise.all(
    config.packages.map((pkg) => resolvePackageConfig(pkg, config, projectRoot))
  );
}

async function persistDetectedSnapshot(
  resolved: ResolvedPackageConfig[],
  projectRoot: string
): Promise<void> {
  if (resolved.length === 0) return;
  try {
    const cacheDir = resolved[0]!.cache.dir;
    await writeDetectedSnapshot(
      detectedSnapshotPath(cacheDir, projectRoot),
      buildDetectedSnapshot(resolved)
    );
  } catch (err) {
    dbg.warn(`Could not persist detected snapshot: ${(err as Error).message}`);
  }
}
