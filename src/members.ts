import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { dbg } from "./logger";
import type { AllowSet, PruneArgs, PruneResult } from "./types";
import { isAbortError, pathExists, toCamelCase, withSignal } from "./utils";
import {
  ensureFileFromCache,
  isPreservedFilename,
  pathMatchesFiles,
  removeIfPresent,
  safeReaddir,
  stripExtension,
} from "./files";
/** Prune flat model/namespace files in one member directory. */
export async function pruneMemberDir(
  cachedDir: string,
  liveDir: string,
  dirName: string,
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  const { config, soft, signal } = args;
  if (!(await pathExists(cachedDir, signal))) return;

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

      if (isPreservedFilename(entry)) {
        await ensureFileFromCache(
          cachedFile,
          liveFile,
          result,
          fullRel,
          signal
        );
        return;
      }

      const memberSymbol = toCamelCase(stripExtension(entry));
      const allowed =
        allowSet.members.has(memberSymbol) ||
        pathMatchesFiles(fullRel, allowSet.files);

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
          "[%s] remove member file (not referenced): %s",
          config.target,
          fullRel
        );
        await removeIfPresent(liveFile, soft, result, fullRel, signal);
      }
    })
  );
}
