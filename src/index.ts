/**
 * Public API — direct exports from implementation modules (no import/re-export indirection).
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
  detectExtensions,
  detectLayout,
  detectMemberDir,
  detectNaming,
  detectPackageConfig,
  scoreConfidence,
} from "./detector";
export type { DetectPackageOptions } from "./detector";
export {
  isPreserved,
  stripExtension,
  symbolToFilename,
} from "./layouts/shared";
export {
  configureLogging,
  dbg,
  emitResult,
  formatResultLine,
  logVerboseRunSummary,
  primeErrorDebug,
} from "./logger";
export { listPresetNames, loadPreset, matchPreset } from "./presets/index";
export { prune } from "./pruner";
export { deepMerge, resolvePackageConfig } from "./resolver";
export {
  scanDirs,
  scanFile,
  type ScanOptions,
  type ScanWalkStats,
} from "./scanner";
export { startWatcher } from "./watcher";
export { isAbortError, toCamelCase } from "./utils";
export type {
  DetectedConfig,
  HookPattern,
  PackageConfig,
  PatternsConfig,
  PruneResult,
  ResolvedPackageConfig,
  RunMode,
  ShakerConfig,
  StructureConfig,
  UsageMap,
} from "./types";
