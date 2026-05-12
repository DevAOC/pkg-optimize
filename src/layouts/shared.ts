import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { dbg } from "../logger";
import type { PruneResult, StructureConfig, UsageMap } from "../types";
import { isAbortError, pathExists, toCamelCase, withSignal } from "../utils";
import type { AllowSet, PruneArgs } from "./types";

/**
 * Builds the `AllowSet` consumed by each layout. Combines scanner output
 * (`usageMap`) with explicit `allow.include` entries and normalises every key
 * through {@link toCamelCase} so case-insensitive matching works downstream.
 */
export function buildAllowSet(
  usageMap: UsageMap,
  allow: { include?: string[] } | undefined
): AllowSet {
  const members = new Set<string>();
  const operations = new Set<string>();
  const files = new Set<string>();

  for (const m of usageMap.members ?? []) members.add(toCamelCase(m));
  for (const o of usageMap.operations ?? []) {
    const [member, operation] = o.split(".");
    if (!member || !operation) continue;
    members.add(toCamelCase(member));
    operations.add(`${toCamelCase(member)}.${toCamelCase(operation)}`);
  }
  for (const f of usageMap.files ?? []) {
    files.add(normalizeFileRef(f));
  }

  for (const sym of allow?.include ?? []) {
    // `allow.include` accepts members, `member.operation`, and explicit
    // `path/to/file` references (anything containing a slash is treated as a
    // file reference rather than a symbol).
    if (sym.includes("/")) {
      files.add(normalizeFileRef(sym));
    } else if (sym.includes(".")) {
      const [member, operation] = sym.split(".");
      if (!member || !operation) continue;
      members.add(toCamelCase(member));
      operations.add(`${toCamelCase(member)}.${toCamelCase(operation)}`);
    } else {
      members.add(toCamelCase(sym));
    }
  }

  for (const o of operations) {
    const [member] = o.split(".");
    if (member) members.add(member);
  }

  return { members, operations, files };
}

export function normalizeFileRef(p: string): string {
  return p
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\\/g, "/");
}

/**
 * Returns true if `relPath` (without extension, slash-separated) matches any
 * entry in `files`, or is a parent or child of one. Used to keep deep-imported
 * files alive even when they don't match a known member.
 */
export function pathMatchesFiles(relPath: string, files: Set<string>): boolean {
  if (files.size === 0) return false;
  const normalized = normalizeFileRef(relPath);
  if (files.has(normalized)) return true;
  for (const entry of files) {
    if (entry === normalized) return true;
    if (normalized.startsWith(entry + "/")) return true; // entry is an ancestor of relPath
    if (entry.startsWith(normalized + "/")) return true; // relPath is an ancestor of entry
  }
  return false;
}

/**
 * Walk the cached package and ensure every file exists in live. Used in
 * dynamic-import wildcard mode: we can't safely remove anything, but we still
 * want to *restore* anything that may have been pruned in a prior run.
 */
export async function restoreAll(
  args: PruneArgs,
  result: PruneResult
): Promise<void> {
  const { sourceDir, targetDir, signal, config } = args;
  dbg.prune(
    "[%s] bulk restore from cache → live (wildcard / restore-only)",
    config.target
  );
  await walkFiles(
    sourceDir,
    async (cachedPath) => {
      const rel = relative(sourceDir, cachedPath).split(sep).join("/");
      const livePath = resolve(targetDir, rel);
      await ensureFileFromCache(
        cachedPath,
        livePath,
        result,
        rel,
        signal,
        true
      );
    },
    signal
  );
  dbg.prune(
    "[%s] bulk restore finished restored=%d kept=%d",
    config.target,
    result.restored.length,
    result.kept.length
  );
}

/**
 * Copies every preserve-listed file at the package root from cache to live
 * (when missing) so that LICENSE / index / package.json are never collateral
 * damage from layout-specific pruning.
 */
export async function preserveTopLevel(
  args: PruneArgs,
  result: PruneResult
): Promise<void> {
  const { config, sourceDir, targetDir, signal } = args;
  const entries = await safeReaddir(sourceDir, signal);
  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const cached = resolve(sourceDir, entry);
      const live = resolve(targetDir, entry);
      let isFile = false;
      try {
        isFile = (await withSignal(signal, () => stat(cached))).isFile();
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }
      if (!isFile) return;
      if (isPreserved(entry, config.packageStructure)) {
        await ensureFileFromCache(cached, live, result, entry, signal);
      }
    })
  );
}

export async function ensureFileFromCache(
  cachedPath: string,
  livePath: string,
  result: PruneResult,
  label: string,
  signal?: AbortSignal,
  quietRestore?: boolean
): Promise<void> {
  signal?.throwIfAborted();
  if (!(await pathExists(cachedPath, signal))) return;
  if (!(await pathExists(livePath, signal))) {
    await withSignal(signal, () =>
      mkdir(dirname(livePath), { recursive: true })
    );
    await withSignal(signal, () =>
      cp(cachedPath, livePath, { recursive: true, force: true })
    );
    if (!quietRestore) {
      dbg.prune("[%s] restored %s", result.packageName, label);
    }
    result.restored.push(label);
  } else {
    result.kept.push(label);
  }
}

export async function removeIfPresent(
  livePath: string,
  soft: boolean | undefined,
  result: PruneResult,
  label: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  if (!(await pathExists(livePath, signal))) return;
  if (soft) {
    dbg.prune("[%s] soft: would remove %s", result.packageName, label);
    result.warnings.push(`Would remove ${label} (soft mode)`);
    return;
  }
  dbg.prune("[%s] removed %s", result.packageName, label);
  await withSignal(signal, () =>
    rm(livePath, { recursive: true, force: true })
  );
  result.removed.push(label);
}

export async function safeReaddir(
  dir: string,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    return await withSignal(signal, () => readdir(dir));
  } catch (err) {
    if (isAbortError(err)) throw err;
    return [];
  }
}

export async function walkFiles(
  dir: string,
  cb: (filePath: string) => void | Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  let entries: string[];
  try {
    entries = await withSignal(signal, () => readdir(dir));
  } catch (err) {
    if (isAbortError(err)) throw err;
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const full = resolve(dir, entry);
      let s;
      try {
        s = await withSignal(signal, () => stat(full));
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }
      if (s.isDirectory()) await walkFiles(full, cb, signal);
      else if (s.isFile()) await cb(full);
    })
  );
}

export function isPreserved(
  filename: string,
  structure: StructureConfig
): boolean {
  return structure.preserve.includes(filename);
}

export function stripExtension(
  filename: string,
  knownExtensions?: string[]
): string {
  if (knownExtensions && knownExtensions.length > 0) {
    const sorted = [...knownExtensions].sort((a, b) => b.length - a.length);
    for (const ext of sorted) {
      if (ext.length > 0 && filename.endsWith(ext)) {
        return filename.slice(0, -ext.length);
      }
    }
  }
  if (filename.endsWith(".d.ts")) return filename.slice(0, -5);
  if (filename.endsWith(".d.mts")) return filename.slice(0, -6);
  if (filename.endsWith(".d.cts")) return filename.slice(0, -6);
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return filename;
  return filename.slice(0, dot);
}

export function symbolToFilename(
  symbol: string,
  naming: StructureConfig["naming"]
): string {
  switch (naming) {
    case "PascalCase":
      return symbol[0]!.toUpperCase() + symbol.slice(1);
    case "camelCase":
      return symbol[0]!.toLowerCase() + symbol.slice(1);
    case "kebab-case":
      return symbol.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    case "snake_case":
      return symbol.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }
}
