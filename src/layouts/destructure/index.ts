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
 * Layout for packages whose top-level entries are themselves the units of
 * pruning — `lodash-es`, `date-fns`, `react-icons/fa`, `@radix-ui/react-icons`,
 * etc. Each direct child of `memberDir` (defaulting to the package root) is
 * either a single file or a directory; we keep or remove it as a whole based
 * on whether its symbol or path is in the allow set.
 */
export async function pruneDestructure(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  const { config, sourceDir, targetDir, soft, signal } = args;
  const memberDirName = config.packageStructure.memberDir ?? ".";
  const cachedRoot = resolve(sourceDir, memberDirName);
  const liveRoot = resolve(targetDir, memberDirName);

  if (!(await pathExists(cachedRoot, signal))) {
    dbg.prune(
      "[%s] skip destructure: cached member root missing: %s",
      config.target,
      memberDirName
    );
    result.warnings.push(
      `Cached member dir ${memberDirName} not found in cache for ${config.target}.`
    );
    return;
  }

  const entries = await safeReaddir(cachedRoot, signal);
  const dirPrefix =
    memberDirName === "." || memberDirName === "" ? "" : `${memberDirName}/`;

  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const cachedEntry = resolve(cachedRoot, entry);
      const liveEntry = resolve(liveRoot, entry);
      try {
        await withSignal(signal, () => stat(cachedEntry));
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }

      const fullRel = `${dirPrefix}${entry}`;

      if (isPreserved(entry, config.packageStructure)) {
        await ensureFileFromCache(
          cachedEntry,
          liveEntry,
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
      const memberSymbol = toCamelCase(stripped);
      const allowed =
        allowSet.members.has(memberSymbol) ||
        pathMatchesFiles(fullRel, allowSet.files) ||
        pathMatchesFiles(`${dirPrefix}${stripped}`, allowSet.files);

      if (allowed) {
        await ensureFileFromCache(
          cachedEntry,
          liveEntry,
          result,
          fullRel,
          signal
        );
      } else {
        dbg.prune(
          "[%s] remove destructure entry (not referenced): %s",
          config.target,
          fullRel
        );
        await removeIfPresent(liveEntry, soft, result, fullRel, signal);
      }
    })
  );

  if (memberDirName !== "." && memberDirName !== "") {
    await preserveTopLevel(args, result);
  }
}
