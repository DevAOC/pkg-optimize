import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { dbg } from "../../logger";
import type { PruneResult } from "../../types";
import { isAbortError, pathExists, toCamelCase, withSignal } from "../../utils";
import {
  ensureFileFromCache,
  isPreserved,
  pathMatchesFiles,
  preserveTopLevel,
  removeIfPresent,
  safeReaddir,
  stripExtension,
} from "../shared";
import type { AllowSet, PruneArgs } from "../types";

/**
 * Layout for packages where every member (and optionally every operation) is
 * a single file directly inside `memberDir` / `operationDir`. The pruner walks
 * one level deep and keeps files whose stem matches an allowed member or
 * `member.operation` symbol.
 */
export async function pruneFlat(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  const { config } = args;
  const memberDirName = config.packageStructure.memberDir;
  const operationDirName = config.packageStructure.operationDir;

  const jobs: Array<Promise<void>> = [];

  if (memberDirName) {
    jobs.push(
      processFlatDir(
        resolve(args.sourceDir, memberDirName),
        resolve(args.targetDir, memberDirName),
        memberDirName,
        "member",
        args,
        allowSet,
        result
      )
    );
  }

  if (operationDirName && operationDirName !== memberDirName) {
    jobs.push(
      processFlatDir(
        resolve(args.sourceDir, operationDirName),
        resolve(args.targetDir, operationDirName),
        operationDirName,
        "operation",
        args,
        allowSet,
        result
      )
    );
  }

  await Promise.all(jobs);
  await preserveTopLevel(args, result);
}

async function processFlatDir(
  cachedDir: string,
  liveDir: string,
  dirName: string,
  kind: "member" | "operation",
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  const { config, soft, signal } = args;
  if (!(await pathExists(cachedDir, signal))) {
    dbg.prune(
      "[%s] skip flat dir: cached path missing: %s",
      config.targetPackage,
      dirName
    );
    result.warnings.push(
      `Cached dir ${dirName} not found for ${config.targetPackage}.`
    );
    return;
  }

  const entries = await safeReaddir(cachedDir, signal);

  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const cachedFile = resolve(cachedDir, entry);
      const liveFile = resolve(liveDir, entry);
      let isDir = false;
      try {
        isDir = (
          await withSignal(signal, () => stat(cachedFile))
        ).isDirectory();
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }

      if (isDir) return;

      const fullRel = `${dirName}/${entry}`;

      if (isPreserved(entry, config.packageStructure)) {
        await ensureFileFromCache(
          cachedFile,
          liveFile,
          result,
          fullRel,
          signal
        );
        return;
      }

      const stripped = stripExtension(
        entry,
        config.packageStructure.extensions
      );
      let allowed = false;
      if (kind === "member") {
        const memberSymbol = toCamelCase(stripped);
        allowed = allowSet.members.has(memberSymbol);
      } else {
        const symbol = toCamelCase(stripped.replace(/[._-]/g, "."));
        allowed = allowSet.operations.has(symbol);
        if (!allowed) {
          const justMember = toCamelCase(stripped);
          allowed = allowSet.members.has(justMember);
        }
      }
      if (!allowed) allowed = pathMatchesFiles(fullRel, allowSet.files);

      if (allowed) {
        await ensureFileFromCache(
          cachedFile,
          liveFile,
          result,
          fullRel,
          signal
        );
      } else {
        dbg.prune(
          "[%s] remove flat entry (not referenced): %s",
          config.targetPackage,
          fullRel
        );
        await removeIfPresent(liveFile, soft, result, fullRel, signal);
      }
    })
  );
}
