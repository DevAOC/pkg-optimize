import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { EXTENSIONS, isPreservedFilename } from "./constants";
import { dbg } from "./logger";
import type { PruneArgs, PruneResult } from "./types";
import { isAbortError, pathExists, withSignal } from "./utils";

export function normalizeFileRef(p: string): string {
  return p
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\\/g, "/");
}

export function pathMatchesFiles(relPath: string, files: Set<string>): boolean {
  if (files.size === 0) return false;
  const normalized = normalizeFileRef(relPath);
  if (files.has(normalized)) return true;
  for (const entry of files) {
    if (entry === normalized) return true;
    if (normalized.startsWith(entry + "/")) return true;
    if (entry.startsWith(normalized + "/")) return true;
  }
  return false;
}

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
      await ensureFileFromCache(
        cachedPath,
        resolve(targetDir, rel),
        result,
        rel,
        signal,
        true
      );
    },
    signal
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

export function stripExtension(filename: string): string {
  if (filename.endsWith(".map") && filename.length > 4) {
    const withoutMap = filename.slice(0, -4);
    if (looksLikeCodeOrDeclarationFile(withoutMap)) {
      return stripExtension(withoutMap);
    }
  }
  for (const ext of [...EXTENSIONS].sort((a, b) => b.length - a.length)) {
    if (filename.endsWith(ext)) return filename.slice(0, -ext.length);
  }
  if (filename.endsWith(".d.ts")) return filename.slice(0, -5);
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return filename;
  return filename.slice(0, dot);
}

function looksLikeCodeOrDeclarationFile(name: string): boolean {
  return (
    name.endsWith(".js") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs") ||
    name.endsWith(".d.ts")
  );
}

export { isPreservedFilename };
