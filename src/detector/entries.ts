import { extname, join, resolve } from "node:path";
import { pathExists } from "../utils";

const RESOLVE_EXTS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".d.mts",
  ".d.cts",
] as const;

function collectEntrySubpathCandidates(
  pkgJson: Record<string, unknown>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: unknown) => {
    if (typeof s !== "string") return;
    const n = s.replace(/^\.\//, "");
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  const exports = pkgJson.exports;
  if (exports && typeof exports === "object" && !Array.isArray(exports)) {
    const dot = (exports as Record<string, unknown>)["."];
    if (typeof dot === "string") push(dot);
    else if (dot && typeof dot === "object" && !Array.isArray(dot)) {
      const o = dot as Record<string, unknown>;
      push(o.import);
      push(o.default);
      push(o.require);
      push(o.types);
    }
  }
  push(pkgJson.module);
  push(pkgJson.main);
  push(pkgJson.types);
  if (out.length === 0) push("index.js");
  return out;
}

export function resolvePackageEntrySubpath(
  pkgJson: Record<string, unknown>
): string | null {
  const c = collectEntrySubpathCandidates(pkgJson);
  return c[0] ?? null;
}

export async function resolveExistingModule(
  absWithoutMandatoryExt: string
): Promise<string | null> {
  if (await pathExists(absWithoutMandatoryExt)) {
    return absWithoutMandatoryExt;
  }
  const ext = extname(absWithoutMandatoryExt);
  if (!ext) {
    for (const e of RESOLVE_EXTS) {
      const withE = absWithoutMandatoryExt + e;
      if (await pathExists(withE)) return withE;
    }
    for (const e of RESOLVE_EXTS) {
      const idx = join(absWithoutMandatoryExt, "index" + e);
      if (await pathExists(idx)) return idx;
    }
  }
  return null;
}

export async function resolvePackageEntryAbs(
  packageRoot: string,
  pkgJson: Record<string, unknown>
): Promise<string | null> {
  for (const sp of collectEntrySubpathCandidates(pkgJson)) {
    const abs = resolve(packageRoot, sp);
    const hit = await resolveExistingModule(abs);
    if (hit) return hit;
  }
  return null;
}

/** Resolve every bundle entry (ESM, CJS, types) for dual-build Gadget clients. */
export async function resolveAllPackageEntries(
  packageRoot: string,
  pkgJson: Record<string, unknown>
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sp of collectEntrySubpathCandidates(pkgJson)) {
    const abs = resolve(packageRoot, sp);
    const hit = await resolveExistingModule(abs);
    if (!hit || seen.has(hit)) continue;
    seen.add(hit);
    out.push(hit);
  }
  return out;
}
