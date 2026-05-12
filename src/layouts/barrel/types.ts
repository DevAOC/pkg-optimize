/**
 * Output of `analyzeBarrelPackage`: a successful plan lists which files in
 * the cached package must stay and which of them are barrel-only modules that
 * can be rewritten in place.
 */
export interface BarrelPlan {
  ok: true;
  /** POSIX paths relative to package root (no leading ./). */
  keepRelPaths: Set<string>;
  /** Barrel-only modules to rewrite (POSIX rel paths). */
  barrelRelPaths: Set<string>;
}

export interface BarrelPlanError {
  ok: false;
  reason: string;
}

export type BarrelAnalyzeResult = BarrelPlan | BarrelPlanError;
