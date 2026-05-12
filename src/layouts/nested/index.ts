import { mkdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
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
  walkFiles,
} from "../shared";
import type { AllowSet, PruneArgs } from "../types";

/**
 * Layout for packages where each member lives in its own subdirectory under
 * `memberDir`, with optional per-operation sub-files
 * (e.g. `models/ShopProduct/ShopProduct.js` + `models/ShopProduct/actions/update.js`).
 *
 * Pruning is two-level:
 *  - Whole member directories are dropped when their symbol is not referenced.
 *  - Inside kept members, individual operation files are dropped unless their
 *    `member.operation` pair is referenced or the file is preserved.
 */
export async function pruneNested(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  const { config, sourceDir, targetDir, soft, signal } = args;
  const memberDirName = config.packageStructure.memberDir ?? "members";
  const cachedMembersDir = resolve(sourceDir, memberDirName);
  const liveMembersDir = resolve(targetDir, memberDirName);

  if (!(await pathExists(cachedMembersDir, signal))) {
    dbg.prune(
      "[%s] skip nested walk: cached member dir missing: %s",
      config.target,
      memberDirName
    );
    result.warnings.push(
      `Cached member dir ${memberDirName} not found in cache for ${config.target}.`
    );
    return;
  }

  const memberEntries = await safeReaddir(cachedMembersDir, signal);

  await Promise.all(
    memberEntries.map(async (entry) => {
      signal?.throwIfAborted();
      const cachedEntryPath = resolve(cachedMembersDir, entry);
      const liveEntryPath = resolve(liveMembersDir, entry);
      let isDir = false;
      try {
        isDir = (
          await withSignal(signal, () => stat(cachedEntryPath))
        ).isDirectory();
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }

      if (!isDir) {
        if (isPreserved(entry, config.packageStructure)) {
          await ensureFileFromCache(
            cachedEntryPath,
            liveEntryPath,
            result,
            entry,
            signal
          );
        }
        return;
      }

      const memberSymbol = toCamelCase(entry);
      const memberAllowed =
        allowSet.members.has(memberSymbol) ||
        pathMatchesFiles(`${memberDirName}/${entry}`, allowSet.files);

      if (!memberAllowed) {
        dbg.prune(
          "[%s] remove member tree (not referenced): %s/%s",
          config.target,
          memberDirName,
          entry
        );
        await removeIfPresent(
          liveEntryPath,
          soft,
          result,
          `${memberDirName}/${entry}`,
          signal
        );
        return;
      }

      if (!(await pathExists(liveEntryPath, signal))) {
        await withSignal(signal, () =>
          mkdir(liveEntryPath, { recursive: true })
        );
      }

      await walkFiles(
        cachedEntryPath,
        async (cachedFilePath) => {
          const relFromMember = relative(cachedEntryPath, cachedFilePath);
          const liveFilePath = resolve(liveEntryPath, relFromMember);
          const segments = relFromMember.split(/[\\/]+/);
          const isOperationFile = segments.length > 1;
          const fullRel = `${memberDirName}/${entry}/${relFromMember}`;

          if (!isOperationFile) {
            await ensureFileFromCache(
              cachedFilePath,
              liveFilePath,
              result,
              fullRel,
              signal
            );
            return;
          }

          const operationFile = segments[segments.length - 1]!;
          if (isPreserved(operationFile, config.packageStructure)) {
            await ensureFileFromCache(
              cachedFilePath,
              liveFilePath,
              result,
              fullRel,
              signal
            );
            return;
          }

          const operationSymbol = toCamelCase(
            stripExtension(operationFile, config.packageStructure.extensions)
          );
          const operationAllowed =
            allowSet.operations.has(`${memberSymbol}.${operationSymbol}`) ||
            pathMatchesFiles(fullRel, allowSet.files);

          if (operationAllowed) {
            await ensureFileFromCache(
              cachedFilePath,
              liveFilePath,
              result,
              fullRel,
              signal
            );
          } else {
            dbg.prune(
              "[%s] remove operation file (not referenced): %s",
              config.target,
              fullRel
            );
            await removeIfPresent(liveFilePath, soft, result, fullRel, signal);
          }
        },
        signal
      );
    })
  );

  await preserveTopLevel(args, result);
}
