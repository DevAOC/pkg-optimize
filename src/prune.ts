import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { dbg } from "./logger";
import type { AllowSet, PruneArgs, PruneResult } from "./types";
import { isAbortError, pathExists, withSignal } from "./utils";
import {
  analyzeBarrelPackage,
  rewriteBarrelSource,
} from "./barrel";
import {
  MEMBER_DIRS,
  PRESERVE_DIR_PREFIXES,
  PRESERVE_REL_PATHS,
} from "./constants";
import {
  ensureFileFromCache,
  isPreservedFilename,
  pathMatchesFiles,
  removeIfPresent,
  walkFiles,
} from "./files";
import { pruneMemberDir } from "./members";

export async function pruneClient(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  const { config, sourceDir, targetDir, soft, signal } = args;

  await Promise.all(
    MEMBER_DIRS.map((dir) =>
      pruneMemberDir(
        resolve(sourceDir, dir),
        resolve(targetDir, dir),
        dir,
        args,
        allowSet,
        result
      )
    )
  );

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(
      await readFile(resolve(sourceDir, "package.json"), "utf-8")
    ) as Record<string, unknown>;
  } catch {
    result.warnings.push(
      `Could not read package.json for ${config.target} — entry rewrite skipped.`
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
      `${config.target}: entry analysis failed (${plan.reason}) — entry files not rewritten.`
    );
    return;
  }

  const keep = new Set(plan.keepRelPaths);
  keep.add("package.json");

  for (const rel of PRESERVE_REL_PATHS) {
    if (await pathExists(resolve(sourceDir, rel), signal)) keep.add(rel);
  }

  await walkFiles(
    sourceDir,
    async (cachedPath) => {
      const rel = relative(sourceDir, cachedPath).split(sep).join("/");
      if (isPreservedFilename(basename(cachedPath))) keep.add(rel);
      if (pathMatchesFiles(rel, allowSet.files)) keep.add(rel);
    },
    signal
  );

  for (const prefix of PRESERVE_DIR_PREFIXES) {
    const abs = resolve(sourceDir, prefix);
    if (!(await pathExists(abs, signal))) continue;
    await walkFiles(
      abs,
      (cachedPath) => {
        keep.add(relative(sourceDir, cachedPath).split(sep).join("/"));
      },
      signal
    );
  }

  await expandKeepWithSidecars(sourceDir, keep, signal);

  await walkFiles(
    sourceDir,
    async (cachedPath) => {
      signal?.throwIfAborted();
      const rel = relative(sourceDir, cachedPath).split(sep).join("/");
      const livePath = resolve(targetDir, rel);

      if (MEMBER_DIRS.some((d) => rel.startsWith(`${d}/`))) {
        return;
      }

      if (!keep.has(rel)) {
        if (isPreservedFilename(basename(cachedPath))) {
          await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
          return;
        }
        dbg.prune(
          "[%s] remove client file (not referenced): %s",
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
            `${config.target}: could not safely rewrite entry file "${rel}" — copied verbatim from cache.`
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
          result.restored.push(rel);
        } else {
          result.kept.push(rel);
        }
        return;
      }

      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
    },
    signal
  );

  dbg.prune(
    "[%s] prune complete: keep=%d entry rewrites=%d",
    config.target,
    keep.size,
    plan.barrelRelPaths.size
  );
}

async function expandKeepWithSidecars(
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
      if (await pathExists(resolve(sourceDir, cand), signal)) keep.add(cand);
    }
  }
  for (const rel of [...keep]) {
    if (!/\.(?:mjs|cjs|js|d\.ts)$/.test(rel)) continue;
    const cand = rel + ".map";
    if (await pathExists(resolve(sourceDir, cand), signal)) keep.add(cand);
  }
}
