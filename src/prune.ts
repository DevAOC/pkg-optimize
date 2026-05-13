import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { rewriteGadgetClientSource } from "./client";
import { dbg } from "./logger";
import type { AllowSet, PruneArgs, PruneResult } from "./types";
import { isAbortError, pathExists, withSignal } from "./utils";
import {
  analyzeBarrelPackage,
  rewriteBarrelSource,
  type BarrelPlan,
} from "./barrel";
import { MODEL_DIRS, PRESERVE_REL_PATHS } from "./constants";
import { ensureFileFromCache } from "./files";
import { pruneMemberDir } from "./members";

export async function pruneClient(
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
      `Could not read package.json for ${config.target} — pruning skipped.`
    );
    return;
  }

  const analyzed = await analyzeBarrelPackage(
    sourceDir,
    pkgJson,
    allowSet.members,
    allowSet.files,
    signal
  );

  const plan: BarrelPlan = analyzed.ok
    ? analyzed
    : {
        ok: true,
        keepRelPaths: new Set([
          "package.json",
          ...(PRESERVE_REL_PATHS as readonly string[]),
        ]),
        barrelRelPaths: new Set(),
      };

  if (!analyzed.ok) {
    result.warnings.push(
      `${config.target}: entry analysis failed (${analyzed.reason}) — barrel rewrite skipped; model pruning still applied.`
    );
  }

  await rewritePreservedClientFiles(args, allowSet.members, result);

  await Promise.all(
    MODEL_DIRS.map((dir) =>
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

  const keep = new Set(plan.keepRelPaths);
  keep.add("package.json");
  for (const rel of PRESERVE_REL_PATHS) {
    if (await pathExists(resolve(sourceDir, rel), signal)) keep.add(rel);
  }
  await expandKeepWithSidecars(sourceDir, keep, signal);

  for (const rel of plan.barrelRelPaths) {
    signal?.throwIfAborted();
    const cachedPath = resolve(sourceDir, rel);
    const livePath = resolve(targetDir, rel);
    if (!(await pathExists(cachedPath, signal))) continue;

    if (soft) {
      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(cachedPath, "utf-8");
    } catch (err) {
      if (isAbortError(err)) throw err;
      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
      continue;
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
      continue;
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
  }

  dbg.prune(
    "[%s] prune complete: models-only deletes, keep=%d entry rewrites=%d",
    config.target,
    keep.size,
    plan.barrelRelPaths.size
  );
}

async function rewritePreservedClientFiles(
  args: PruneArgs,
  keepCamelMembers: Set<string>,
  result: PruneResult
): Promise<void> {
  const { config, sourceDir, targetDir, soft, signal } = args;

  for (const rel of PRESERVE_REL_PATHS) {
    if (basename(rel) !== "Client.js") continue;
    const cachedPath = resolve(sourceDir, rel);
    if (!(await pathExists(cachedPath, signal))) continue;

    const livePath = resolve(targetDir, rel);
    if (soft) {
      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(cachedPath, "utf-8");
    } catch (err) {
      if (isAbortError(err)) throw err;
      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
      continue;
    }

    const rewritten = rewriteGadgetClientSource(raw, keepCamelMembers);
    if (!rewritten.ok) {
      result.warnings.push(
        `${config.target}: could not rewrite "${rel}" — copied verbatim from cache.`
      );
      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
      continue;
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
  }
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
