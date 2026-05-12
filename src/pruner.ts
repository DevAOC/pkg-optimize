import { dbg } from "./logger";
import { pruneBarrel } from "./layouts/barrel/index";
import { pruneDestructure } from "./layouts/destructure/index";
import { pruneFlat } from "./layouts/flat/index";
import { pruneNested } from "./layouts/nested/index";
import { buildAllowSet, restoreAll } from "./layouts/shared";
import type { AllowSet, PruneArgs } from "./layouts/types";
import type { PruneResult, StructureConfig } from "./types";
import { pathExists } from "./utils";

/**
 * Entry point: build the allow-set for `usageMap`, choose the right layout
 * strategy, and let it mutate the live `node_modules` copy. Each strategy
 * lives in `src/layouts/<layout>/index.ts`.
 */
export async function prune(args: PruneArgs): Promise<PruneResult> {
  const { usageMap, config, sourceDir, signal } = args;
  signal?.throwIfAborted();
  const allowSet = buildAllowSet(usageMap, config.allow);
  const layout = config.packageStructure.layout;

  dbg.prune(
    "[%s] start layout=%s soft=%s wildcard=%s members=%d operations=%d files=%d",
    config.target,
    layout,
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
    dbg.prune("[%s] skip: no cache at %s", config.target, sourceDir);
    result.warnings.push(
      `No cache found at ${sourceDir}. Skipping prune for ${config.target}.`
    );
    dbg.prune(
      "[%s] done (aborted: no cache) warnings=%d",
      config.target,
      result.warnings.length
    );
    return result;
  }

  // Dynamic-import escape hatch: when the scanner saw an `import('pkg')` /
  // `require('pkg')` / `import(somePath)` it couldn't statically resolve, we
  // can't safely remove anything. Restore everything and bail.
  if (usageMap.wildcard) {
    dbg.prune(
      "[%s] skip prune: dynamic import / unresolved path — restore-only",
      config.target
    );
    await restoreAll(args, result);
    result.warnings.push(
      `${config.target}: dynamic import detected with an unresolvable target — pruning skipped, all files kept/restored.`
    );
    dbg.prune(
      "[%s] done (restore-only) restored=%d kept=%d warnings=%d",
      config.target,
      result.restored.length,
      result.kept.length,
      result.warnings.length
    );
    return result;
  }

  await dispatchLayout(layout, args, allowSet, result);

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

async function dispatchLayout(
  layout: StructureConfig["layout"],
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult
): Promise<void> {
  switch (layout) {
    case "nested":
      return pruneNested(args, allowSet, result);
    case "flat":
      return pruneFlat(args, allowSet, result);
    case "destructure":
      return pruneDestructure(args, allowSet, result);
    case "barrel":
      return pruneBarrel(args, allowSet, result);
  }
}
