import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { dbg } from "../../logger";
import type { PruneResult } from "../../types";
import { isAbortError, pathExists, withSignal } from "../../utils";
import {
  ensureFileFromCache,
  isPreserved,
  pathMatchesFiles,
  removeIfPresent,
  walkFiles,
} from "../shared";
import type { AllowSet, PruneArgs } from "../types";
import { analyzeBarrelPackage, rewriteBarrelSource } from "./graph";

/**
 * Layout for packages whose entry file (and optionally inner re-export
 * modules) is mostly `export { … } from './…'`. We statically trace which
 * exports are reachable for the allowed members, drop unreachable
 * implementation files, and rewrite remaining barrel files so they no longer
 * reference deleted modules. Single-file barrels are left untouched.
 */
export async function pruneBarrel(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  const { config, sourceDir, targetDir, soft, signal } = args;
  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(
      await readFile(resolve(sourceDir, "package.json"), "utf-8")
    ) as Record<string, unknown>;
  } catch {
    result.warnings.push(
      `Could not read package.json for ${config.target} — barrel pruning skipped.`
    );
    return;
  }

  const plan = await analyzeBarrelPackage(
    sourceDir,
    pkgJson,
    allowSet.members,
    allowSet.files,
    signal
  );

  if (!plan.ok) {
    result.warnings.push(
      `${config.target}: barrel analysis failed (${plan.reason}) — pruning skipped.`
    );
    return;
  }

  const keep = new Set(plan.keepRelPaths);

  await walkFiles(
    sourceDir,
    async (cachedPath) => {
      const rel = relative(sourceDir, cachedPath).split(sep).join("/");
      const name = basename(cachedPath);
      if (isPreserved(name, config.packageStructure)) {
        keep.add(rel);
      }
      if (pathMatchesFiles(rel, allowSet.files)) {
        keep.add(rel);
      }
    },
    signal
  );

  await expandKeepWithDeclarationSidecars(sourceDir, keep, signal);

  await walkFiles(
    sourceDir,
    async (cachedPath) => {
      signal?.throwIfAborted();
      const rel = relative(sourceDir, cachedPath).split(sep).join("/");
      const livePath = resolve(targetDir, rel);
      const name = basename(cachedPath);

      if (!keep.has(rel)) {
        if (isPreserved(name, config.packageStructure)) {
          await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
          return;
        }
        dbg.prune(
          "[%s] remove barrel package file (not referenced): %s",
          config.target,
          rel
        );
        await removeIfPresent(livePath, soft, result, rel, signal);
        return;
      }

      if (soft) {
        await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
        return;
      }

      if (plan.barrelRelPaths.has(rel)) {
        let raw: string;
        try {
          raw = await readFile(cachedPath, "utf-8");
        } catch (err) {
          if (isAbortError(err)) throw err;
          await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
          return;
        }
        const rewritten = await rewriteBarrelSource(raw, allowSet.members, {
          packageRoot: sourceDir,
          fileAbs: cachedPath,
          keepRelPaths: keep,
        });
        if (!rewritten.ok || !rewritten.code.trim()) {
          result.warnings.push(
            `${config.target}: could not safely rewrite barrel file "${rel}" — copied verbatim from cache.`
          );
          await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
          return;
        }
        const existed = await pathExists(livePath, signal);
        await withSignal(signal, () =>
          mkdir(dirname(livePath), { recursive: true })
        );
        await withSignal(signal, () =>
          writeFile(livePath, rewritten.code, "utf8")
        );
        if (!existed) {
          dbg.prune("[%s] restored (rewritten) %s", config.target, rel);
          result.restored.push(rel);
        } else {
          dbg.prune("[%s] kept (rewritten) %s", config.target, rel);
          result.kept.push(rel);
        }
        return;
      }

      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
    },
    signal
  );

  dbg.prune(
    "[%s] barrel prune: keep=%d barrel rewrites=%d",
    config.target,
    keep.size,
    plan.barrelRelPaths.size
  );
}

/**
 * Whenever we keep a JS / MJS / CJS file we also need to keep its parallel
 * `.d.ts` / `.d.mts` / `.d.cts` sidecar (when one exists). Without this the
 * declaration files would be left dangling and break consumers.
 */
async function expandKeepWithDeclarationSidecars(
  sourceDir: string,
  keep: Set<string>,
  signal?: AbortSignal
): Promise<void> {
  const snapshot = [...keep];
  for (const rel of snapshot) {
    if (!/\.(mjs|cjs|js)$/.test(rel)) continue;
    const stem = rel.replace(/\.(mjs|cjs|js)$/, "");
    for (const te of [".d.ts", ".d.mts", ".d.cts"] as const) {
      const cand = stem + te;
      const abs = resolve(sourceDir, cand);
      if (await pathExists(abs, signal)) keep.add(cand);
    }
  }
}
