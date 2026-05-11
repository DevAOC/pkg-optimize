export {
  loadConfig,
  writeConfig,
  findConfig,
  validate as validateConfig,
  applyTopLevelDefaults,
  detectScanDirs,
  CONFIG_FILENAME,
} from "./config.js";
export {
  detectPackageConfig,
  detectLayout,
  detectMemberDir,
  detectNaming,
  detectExtensions,
  scoreConfidence,
} from "./detector.js";
export { scanDirs, scanFile } from "./scanner.js";
export type { ScanOptions } from "./scanner.js";
export {
  prune,
  toCamelCase,
  symbolToFilename,
  isPreserved,
  stripExtension,
} from "./pruner.js";
export { ShakerCache } from "./cache.js";
export { resolvePackageConfig, deepMerge } from "./resolver.js";
export { startWatcher } from "./watcher.js";
export { loadPreset, matchPreset, listPresetNames } from "./presets/index.js";
export { log } from "./logger.js";
export { runCli } from "./cli.js";
export { isAbortError } from "./utils.js";

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
} from "./types.js";
