import { buildAllowSet } from "./allow";
import { restoreAll } from "./files";
import { pruneClient } from "./prune";
import { dbg } from "./logger";
import type { PruneArgs, PruneResult } from "./types";
import { pathExists } from "./utils";

export async function prune(args: PruneArgs): Promise<PruneResult> {
  const { usageMap, config, sourceDir, signal } = args;
  signal?.throwIfAborted();
  const allowSet = buildAllowSet(usageMap, config.allow);

  dbg.prune(
    "[%s] start soft=%s wildcard=%s members=%d operations=%d files=%d",
    config.target,
    String(!!args.soft),
    String(!!usageMap.wildcard),
    usageMap.members?.size ?? 0,
    usageMap.operations?.size ?? 0,
    usageMap.files?.size ?? 0
  );

  const result: PruneResult = {
    packageName: config.target,
    removed: [],
    restored: [],
    kept: [],
    warnings: [],
  };

  if (!(await pathExists(sourceDir, signal))) {
    result.warnings.push(
      `No cache found at ${sourceDir}. Skipping prune for ${config.target}.`
    );
    return result;
  }

  if (usageMap.wildcard) {
    await restoreAll(args, result);
    result.warnings.push(
      `${config.target}: dynamic import detected with an unresolvable target — pruning skipped, all files kept/restored.`
    );
    return result;
  }

  await pruneClient(args, allowSet, result);

  dbg.prune(
    "[%s] done removed=%d restored=%d kept=%d warnings=%d",
    config.target,
    result.removed.length,
    result.restored.length,
    result.kept.length,
    result.warnings.length
  );

  return result;
}

export type { PruneArgs };
