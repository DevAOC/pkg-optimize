import { ShakerCache } from "./cache";
import { runCli } from "./cli";
import {
  applyTopLevelDefaults,
  CONFIG_FILENAME,
  detectScanDirs,
  findConfig,
  loadConfig,
  validate,
  writeConfig,
} from "./config";
import {
  detectExtensions,
  detectLayout,
  detectMemberDir,
  detectNaming,
  detectPackageConfig,
  scoreConfidence,
} from "./detector";
import {
  isPreserved,
  stripExtension,
  symbolToFilename,
} from "./layouts/shared";
import {
  configureLogging,
  dbg,
  emitResult,
  formatResultLine,
  logVerboseRunSummary,
  primeErrorDebug,
} from "./logger";
import { listPresetNames, loadPreset, matchPreset } from "./presets/index";
import { prune } from "./pruner";
import { deepMerge, resolvePackageConfig } from "./resolver";
import {
  scanDirs,
  scanFile,
  type ScanOptions,
  type ScanWalkStats,
} from "./scanner";
import { startWatcher } from "./watcher";
import { isAbortError, toCamelCase } from "./utils";
import type {
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

export {
  CONFIG_FILENAME,
  applyTopLevelDefaults,
  detectScanDirs,
  findConfig,
  loadConfig,
  validate as validateConfig,
  writeConfig,
  detectExtensions,
  detectLayout,
  detectMemberDir,
  detectNaming,
  detectPackageConfig,
  scoreConfidence,
  scanDirs,
  scanFile,
  prune,
  isPreserved,
  stripExtension,
  symbolToFilename,
  ShakerCache,
  resolvePackageConfig,
  deepMerge,
  startWatcher,
  loadPreset,
  matchPreset,
  listPresetNames,
  configureLogging,
  dbg,
  emitResult,
  formatResultLine,
  logVerboseRunSummary,
  primeErrorDebug,
  runCli,
  isAbortError,
  toCamelCase,
};

export type {
  DetectedConfig,
  HookPattern,
  PackageConfig,
  PatternsConfig,
  PruneResult,
  ResolvedPackageConfig,
  RunMode,
  ScanOptions,
  ScanWalkStats,
  ShakerConfig,
  StructureConfig,
  UsageMap,
};
