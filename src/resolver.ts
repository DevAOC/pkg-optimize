import { detectPackageConfig } from "./detector";
import {
  CLIENT_ENTRY,
  DEFAULT_SCAN_DIRS,
  SCAN_PATTERNS,
} from "./constants";
import type {
  PackageConfig,
  ResolvedPackageConfig,
  ShakerConfig,
} from "./types";

function normalizeEntryPaths(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/** User entry override, else `.gadget/client`. */
export function resolveEntryForDetect(
  user: string | string[] | undefined
): string | string[] {
  const paths = normalizeEntryPaths(user);
  if (paths.length === 0) return CLIENT_ENTRY;
  if (paths.length === 1) return paths[0]!;
  return paths;
}

const BUILT_IN_DEFAULTS = {
  cache: { dir: ".pkg-optimize-cache" },
  watch: { debounceMs: 300, softPruneInDev: true },
};

export async function resolvePackageConfig(
  pkgConfig: PackageConfig,
  topLevel: ShakerConfig,
  projectRoot: string
): Promise<ResolvedPackageConfig> {
  const detected = await detectPackageConfig(pkgConfig.target, projectRoot, {
    entry: resolveEntryForDetect(pkgConfig.entry),
  });

  const scanDirs =
    pkgConfig.scanDirs && pkgConfig.scanDirs.length > 0
      ? pkgConfig.scanDirs
      : topLevel.scanDirs && topLevel.scanDirs.length > 0
      ? topLevel.scanDirs
      : [...DEFAULT_SCAN_DIRS];

  const cache = deepMerge(BUILT_IN_DEFAULTS.cache, topLevel.cache ?? {});
  const watch = deepMerge(BUILT_IN_DEFAULTS.watch, topLevel.watch ?? {});

  return {
    target: pkgConfig.target,
    entry: pkgConfig.entry,
    scanDirs,
    allow: pkgConfig.allow,
    patterns: SCAN_PATTERNS,
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
