import { resolve } from 'node:path';
import { ShakerCache } from './cache.js';
import { loadConfig, writeConfig } from './config.js';
import { log } from './logger.js';
import { prune } from './pruner.js';
import { resolvePackageConfig } from './resolver.js';
import { scanDirs } from './scanner.js';
import { startWatcher } from './watcher.js';
import type { PruneResult, ResolvedPackageConfig } from './types.js';

export interface CliOptions {
  argv?: string[];
  cwd?: string;
}

export async function runCli(options: CliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();

  const flagSet = new Set(argv.filter((a) => a.startsWith('--')));
  if (flagSet.has('--help') || flagSet.has('-h') || argv[0] === 'help') {
    printHelp();
    return 0;
  }
  if (flagSet.has('--version') || flagSet.has('-v')) {
    printVersion();
    return 0;
  }

  const verbose = flagSet.has('--verbose');
  const silent = flagSet.has('--silent');
  if (verbose) log.setLevel('debug');
  else if (silent) log.setLevel('error');

  const mode = (argv.find((a) => !a.startsWith('--')) ?? 'run') as
    | 'run'
    | 'watch';

  if (mode !== 'run' && mode !== 'watch') {
    log.error(`Unknown command: ${mode}`);
    printHelp();
    return 1;
  }

  let configBundle: ReturnType<typeof loadConfig>;
  try {
    configBundle = loadConfig(cwd);
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }

  const { config, configPath } = configBundle;

  if (!config.packages || config.packages.length === 0) {
    log.warn(
      'No packages configured. Add a "packages" array to pkg-optimize.config.json.',
    );
    return 0;
  }

  if (mode === 'watch') {
    const stop = await startWatcher({ config, configPath, projectRoot: cwd });
    // Keep the process alive until the user kills it.
    process.on('SIGINT', () => {
      stop().then(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      stop().then(() => process.exit(0));
    });
    return new Promise<number>(() => {
      /* never resolves; let signals end the process */
    });
  }

  // One-shot run.
  const resolved = await Promise.all(
    config.packages.map((pkg) => resolvePackageConfig(pkg, config, cwd)),
  );

  const results: PruneResult[] = [];
  for (const pkg of resolved) {
    results.push(await runOnce(pkg, cwd));
  }

  // Write detected values back on first run.
  const hasUndetected = config.packages.some((p) => !p._detected);
  if (hasUndetected) {
    try {
      writeConfig(
        {
          ...config,
          packages: config.packages.map((p, i) => ({
            ...p,
            _detected: resolved[i]!._detected,
          })),
        },
        configPath,
      );
    } catch (err) {
      log.warn(`Could not persist detected config: ${(err as Error).message}`);
    }
  }

  for (const r of results) log.result(r);

  const totalRemoved = results.reduce((acc, r) => acc + r.removed.length, 0);
  const totalKept = results.reduce((acc, r) => acc + r.kept.length, 0);
  log.info(
    `Done. ${totalRemoved} file(s) removed, ${totalKept} kept across ${results.length} package(s).`,
  );

  return 0;
}

async function runOnce(
  pkg: ResolvedPackageConfig,
  cwd: string,
): Promise<PruneResult> {
  const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, cwd);

  if (!cache.livePackageExists()) {
    return {
      packageName: pkg.targetPackage,
      removed: [],
      restored: [],
      kept: [],
      warnings: [
        `Package not installed at ${resolve(cwd, 'node_modules', pkg.targetPackage)}. Skipping.`,
      ],
    };
  }

  if (!cache.isCached()) cache.prime();
  // Refresh cache if upstream changed.
  cache.reprime();

  const usageMap = scanDirs(pkg.scanDirs, cwd, pkg.patterns, {
    targetPackage: pkg.targetPackage,
  });
  return prune({
    usageMap,
    config: pkg,
    sourceDir: cache.getCachedPackageDir(),
    targetDir: cache.getLivePackageDir(),
    soft: false,
  });
}

function printHelp(): void {
  console.log(`pkg-optimize — Tree-shake generated API client packages.

Usage:
  pkg-optimize [run|watch] [options]

Commands:
  run               One-shot prune. Default if omitted.
  watch             Watch source dirs, target packages, and config.
  help              Show this help message.

Options:
  --verbose         Verbose logging.
  --silent          Errors only.
  --help, -h        Show help.
  --version, -v     Show version.

Configuration:
  Place a pkg-optimize.config.json file at the root of your project.
  See https://github.com/your-org/pkg-optimize for full docs.
`);
}

function printVersion(): void {
  // Version is injected at build time, fall back to a placeholder.
  const version = process.env.PKG_OPTIMIZE_VERSION ?? '0.1.0';
  console.log(version);
}
