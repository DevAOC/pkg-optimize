import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathExists } from "../utils";
import type { DetectedConfig, ResolvedPackageConfig } from "../types";

export const DETECTED_FILENAME = "_detected.json";

const SNAPSHOT_VERSION = 1 as const;

export interface DetectedSnapshot {
  version: typeof SNAPSHOT_VERSION;
  packages: Record<string, DetectedConfig>;
}

/**
 * Path to the on-disk detected snapshot. Lives inside the project's cache dir
 * so it stays grouped with other regenerable state and inherits the same
 * gitignore as the cache itself.
 */
export function detectedSnapshotPath(
  cacheDir: string,
  projectRoot: string
): string {
  return resolve(projectRoot, cacheDir, DETECTED_FILENAME);
}

export function buildDetectedSnapshot(
  resolved: ResolvedPackageConfig[]
): DetectedSnapshot {
  const packages: Record<string, DetectedConfig> = {};
  for (const pkg of resolved) {
    packages[pkg.target] = pkg.detected;
  }
  return { version: SNAPSHOT_VERSION, packages };
}

export async function readDetectedSnapshot(
  path: string
): Promise<DetectedSnapshot | null> {
  if (!(await pathExists(path))) return null;
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as { version?: unknown }).version !== SNAPSHOT_VERSION
    ) {
      return null;
    }
    return raw as DetectedSnapshot;
  } catch {
    return null;
  }
}

export async function writeDetectedSnapshot(
  path: string,
  snapshot: DetectedSnapshot
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
}
