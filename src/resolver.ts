import { resolve } from "node:path";
import { detectPackageConfig } from "./detector";
import { isDirectory } from "./utils";
import { loadPreset, matchPreset } from "./presets/index";
import type {
  PackageConfig,
  ResolvedPackageConfig,
  ShakerConfig,
} from "./types";

const BUILT_IN_DEFAULTS = {
  patterns: {
    namespace: "client",
    accessStyle: "member" as const,
    depth: { member: 1, operation: 2 },
    hooks: [] as never[],
  },
  packageStructure: {
    layout: "flat" as const,
    naming: "PascalCase" as const,
    extensions: [".js", ".d.ts"],
    preserve: [
      "index.js",
      "index.d.ts",
      "index.mjs",
      "index.cjs",
      "types.js",
      "types.d.ts",
      "package.json",
    ],
  },
  cache: { dir: ".pkg-optimize-cache" },
  watch: { debounceMs: 300, softPruneInDev: true },
};

export async function resolvePackageConfig(
  pkgConfig: PackageConfig,
  topLevel: ShakerConfig,
  projectRoot: string
): Promise<ResolvedPackageConfig> {
  const explicitPreset = pkgConfig.extends
    ? loadPreset(pkgConfig.extends)
    : null;
  const autoPreset = explicitPreset ?? matchPreset(pkgConfig.target);
  const detected = await detectPackageConfig(pkgConfig.target, projectRoot, {
    entry: pkgConfig.entry,
  });

  const patterns = deepMerge(
    BUILT_IN_DEFAULTS.patterns,
    autoPreset?.patterns ?? {},
    detected.patterns ?? {},
    pkgConfig.patterns ?? {}
  );

  const packageStructure = deepMerge(
    BUILT_IN_DEFAULTS.packageStructure,
    autoPreset?.packageStructure ?? {},
    detected.packageStructure ?? {},
    pkgConfig.packageStructure ?? {}
  );

  const scanDirs =
    pkgConfig.scanDirs && pkgConfig.scanDirs.length > 0
      ? pkgConfig.scanDirs
      : topLevel.scanDirs && topLevel.scanDirs.length > 0
      ? topLevel.scanDirs
      : await detectScanDirs(projectRoot);

  const cache = deepMerge(BUILT_IN_DEFAULTS.cache, topLevel.cache ?? {});
  const watch = deepMerge(BUILT_IN_DEFAULTS.watch, topLevel.watch ?? {});

  return {
    ...pkgConfig,
    patterns,
    packageStructure,
    scanDirs,
    cache,
    watch,
    detected,
  };
}

export function deepMerge<T extends object>(
  ...sources: Array<Partial<T> | object>
): T {
  const result: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined || value === null) continue;
      const existing = result[key];
      if (
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        existing !== null
      ) {
        result[key] = deepMerge(
          existing as Record<string, unknown>,
          value as Record<string, unknown>
        );
      } else {
        result[key] = value;
      }
    }
  }
  return result as T;
}

async function detectScanDirs(cwd: string): Promise<string[]> {
  const candidates = ["src", "web", "extensions", "app"];
  const checks = await Promise.all(
    candidates.map(async (dir) => ({
      dir,
      isDir: await isDirectory(resolve(cwd, dir)),
    }))
  );
  return checks.reduce<string[]>((acc, c) => {
    if (c.isDir) acc.push(c.dir);
    return acc;
  }, []);
}
