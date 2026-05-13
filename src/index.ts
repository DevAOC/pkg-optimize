/**
 * Public API for the Gadget client optimizer.
 */

export { ShakerCache } from "./cache";
export { runCli } from "./cli";
export {
  applyTopLevelDefaults,
  CONFIG_FILENAME,
  detectScanDirs,
  findConfig,
  loadConfig,
  validate as validateConfig,
  writeConfig,
} from "./config";
export {
  detectPackageConfig,
  resolveAllPackageEntries,
  resolvePackageEntryAbs,
} from "./detector";
export type { DetectPackageOptions } from "./detector";
export {
  CLIENT_ENTRY,
  DEFAULT_SCAN_DIRS,
  MEMBER_DIRS,
  MODEL_DIRS,
  SCAN_PATTERNS,
} from "./constants";
export { stripExtension } from "./files";
export {
  configureLogging,
  dbg,
  emitResult,
  formatResultLine,
  logVerboseRunSummary,
  primeErrorDebug,
} from "./logger";
export { prune } from "./pruner";
export { deepMerge, resolveEntryForDetect, resolvePackageConfig } from "./resolver";
export {
  scanDirs,
  scanFile,
  type ScanOptions,
  type ScanWalkStats,
} from "./scanner";
export { startWatcher } from "./watcher";
export { isAbortError, toCamelCase } from "./utils";
export type {
  AllowSet,
  DetectedConfig,
  HookPattern,
  PackageConfig,
  PatternsConfig,
  PruneResult,
  PruneArgs,
  ResolvedPackageConfig,
  RunMode,
  ShakerConfig,
  UsageMap,
} from "./types";
