import type { PruneResult, ResolvedPackageConfig, UsageMap } from "../types";

/**
 * Arguments passed to every layout's prune implementation. The dispatcher in
 * `src/pruner.ts` builds this once per package and forwards it to whichever
 * layout matches `config.packageStructure.layout`.
 */
export interface PruneArgs {
  usageMap: UsageMap;
  config: ResolvedPackageConfig;
  /** The pristine cached copy. */
  sourceDir: string;
  /** The live `node_modules` copy that gets mutated. */
  targetDir: string;
  /** When true, do not delete from disk — only warn. Restores still happen. */
  soft?: boolean;
  /** Aborted scans/prunes stop cooperatively (watch shutdown, SIGINT, etc.). */
  signal?: AbortSignal;
}

/**
 * Normalised view of what the scanner + config say we are allowed to keep.
 * Built once by `buildAllowSet` and consumed by every layout.
 */
export interface AllowSet {
  members: Set<string>;
  operations: Set<string>;
  /** Paths (without extension, slash-separated, relative to package root). */
  files: Set<string>;
}

export type LayoutPrune = (
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
) => Promise<void>;
