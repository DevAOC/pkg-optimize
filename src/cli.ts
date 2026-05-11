import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isAbortError } from "./utils.js";
import { ShakerCache } from "./cache.js";
import { loadConfig, writeConfig } from "./config.js";
import { log } from "./logger.js";
import { prune } from "./pruner.js";
import { resolvePackageConfig } from "./resolver.js";
import { scanDirs } from "./scanner.js";
import { startWatcher } from "./watcher.js";
import type { PruneResult, ResolvedPackageConfig } from "./types.js";

export interface CliOptions {
  argv?: string[];
  cwd?: string;
  signal?: AbortSignal;
}

const PARSE_ARGS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  verbose: { type: "boolean" },
  silent: { type: "boolean" },
} as const;

export async function runCli(options: CliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();

  let values: {
    help?: boolean;
    version?: boolean;
    verbose?: boolean;
    silent?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: PARSE_ARGS_OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    log.error((err as Error).message);
    printHelp();
    return 1;
  }

  if (values.help || positionals[0] === "help") {
    printHelp();
    return 0;
  }
  if (values.version) {
    printVersion();
    return 0;
  }

  if (values.verbose) log.setLevel("debug");
  else if (values.silent) log.setLevel("error");

  const mode = (positionals[0] ?? "run") as "run" | "watch";

  if (mode !== "run" && mode !== "watch") {
    log.error(`Unknown command: ${mode}`);
    printHelp();
    return 1;
  }

  let configBundle: Awaited<ReturnType<typeof loadConfig>>;
  try {
    configBundle = await loadConfig(cwd);
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

  let cleanedUp = false;
  const ownController = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? ownController!.signal;

  function onProcessAbort(): void {
    ownController?.abort();
  }

  const disposeSignalHandlers = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (!options.signal && ownController) {
      process.removeListener("SIGINT", onProcessAbort);
      process.removeListener("SIGTERM", onProcessAbort);
    }
  };

  if (ownController) {
    process.once("SIGINT", onProcessAbort);
    process.once("SIGTERM", onProcessAbort);
  }

  try {
    if (mode === "watch") {
      const stop = await startWatcher({
        config,
        configPath,
        projectRoot: cwd,
        signal,
      });
      return await new Promise<number>((resolve) => {
        const finish = async (): Promise<void> => {
          try {
            await stop();
          } catch (err) {
            log.error(
              (err as Error).stack ?? (err as Error).message ?? String(err),
            );
          } finally {
            disposeSignalHandlers();
            resolve(0);
          }
        };
        if (signal.aborted) void finish();
        else
          signal.addEventListener("abort", () => void finish(), { once: true });
      });
    }

    // One-shot run.
    // TODO: Evaluate using p-map instead of Promise.all
    const resolved = await Promise.all(
      config.packages.map((pkg) => resolvePackageConfig(pkg, config, cwd)),
    );

    const results: PruneResult[] = [];
    for (const pkg of resolved) {
      signal.throwIfAborted();
      results.push(await runOnce(pkg, cwd, signal));
    }

    // Write detected values back on first run.
    const hasUndetected = config.packages.some((p) => !p._detected);
    if (hasUndetected) {
      try {
        await writeConfig(
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
        log.warn(
          `Could not persist detected config: ${(err as Error).message}`,
        );
      }
    }

    for (const r of results) log.result(r);

    const totalRemoved = results.reduce((acc, r) => acc + r.removed.length, 0);
    const totalKept = results.reduce((acc, r) => acc + r.kept.length, 0);
    log.info(
      `Done. ${totalRemoved} file(s) removed, ${totalKept} kept across ${results.length} package(s).`,
    );

    return 0;
  } catch (err) {
    if (isAbortError(err)) {
      log.info("Interrupted.");
      return 130;
    }
    throw err;
  } finally {
    disposeSignalHandlers();
  }
}

async function runOnce(
  pkg: ResolvedPackageConfig,
  cwd: string,
  signal: AbortSignal,
): Promise<PruneResult> {
  const cache = new ShakerCache(pkg.cache.dir, pkg.targetPackage, cwd);

  if (!(await cache.livePackageExists())) {
    return {
      packageName: pkg.targetPackage,
      removed: [],
      restored: [],
      kept: [],
      warnings: [
        `Package not installed at ${resolve(
          cwd,
          "node_modules",
          pkg.targetPackage,
        )}. Skipping.`,
      ],
    };
  }

  if (!(await cache.isCached())) await cache.prime({ signal });
  // Refresh cache if upstream changed.
  await cache.reprime({ signal });

  const usageMap = await scanDirs(pkg.scanDirs, cwd, pkg.patterns, {
    targetPackage: pkg.targetPackage,
    signal,
  });
  return prune({
    usageMap,
    config: pkg,
    sourceDir: cache.getCachedPackageDir(),
    targetDir: cache.getLivePackageDir(),
    soft: false,
    signal,
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
  See https://github.com/DevAOC/pkg-optimize for full docs.
`);
}

function printVersion(): void {
  // Version is injected at build time, fall back to a placeholder.
  const version = process.env.PKG_OPTIMIZE_VERSION ?? "0.1.0";
  console.log(version);
}
// Only the dedicated CLI bundle should auto-run. The same source is also bundled
// into `dist/index.js` for `runCli` — that file must not start the CLI on import.
//
// Prefer `import.meta.main` (Node 22.18+). On earlier 22.x releases (e.g. CI on
// 22.14), it is undefined, so fall back to comparing real paths: `argv[1]` is often
// a `node_modules/.bin/pkg-optimize` symlink and must resolve to this file. Use
// plain path strings from `realpathSync`, not `pathToFileURL(...).href` (encoding
// and platform differences can make hrefs differ while paths match).
function isBuiltCliBundle(): boolean {
  try {
    return /^cli\.(js|ts|cjs)$/.test(basename(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

const importMeta = import.meta as ImportMeta & { readonly main?: boolean };

const shouldAutoRun = (() => {
  if (typeof process === "undefined" || !isBuiltCliBundle()) return false;

  if (importMeta.main === true) return true;
  if (importMeta.main === false) return false;

  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (shouldAutoRun) {
  void (async () => {
    try {
      const code = await runCli();
      if (typeof code === "number") process.exit(code);
    } catch (err) {
      log.error((err as Error).stack ?? (err as Error).message ?? String(err));
      process.exit(1);
    }
  })();
}
