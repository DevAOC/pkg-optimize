import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isDirectory, pathExists } from "../utils";
import type {
  DetectedConfig,
  HookPattern,
  PatternsConfig,
  StructureConfig,
} from "../types";
import { matchPreset } from "../presets/index";

const DEFAULT_PRESERVE = [
  "index.js",
  "index.d.ts",
  "index.mjs",
  "index.cjs",
  "types.js",
  "types.d.ts",
  "package.json",
];

/**
 * Common folder names used by codegen tools to hold their per-member files.
 * Order matters: the first match wins.
 */
const KNOWN_MEMBER_DIRS = [
  "models",
  "operations",
  "queries",
  "resources",
  "routers",
  "endpoints",
  "__generated__",
  "hooks",
];

// --- Package entry resolution (shared with barrel tracing) -----------------

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

/** Ordered subpaths to try for `resolvePackageEntryAbs` (first match on disk wins). */
function collectEntrySubpathCandidates(
  pkgJson: Record<string, unknown>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: unknown) => {
    if (typeof s !== "string") return;
    const n = normalizeEntrySubpath(s);
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

/** First candidate subpath (legacy / single-path callers). */
export function resolvePackageEntrySubpath(
  pkgJson: Record<string, unknown>,
): string | null {
  const c = collectEntrySubpathCandidates(pkgJson);
  return c[0] ?? null;
}

function normalizeEntrySubpath(s: string): string {
  return s.replace(/^\.\//, "");
}

export async function resolveExistingModule(
  absWithoutMandatoryExt: string,
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
  pkgJson: Record<string, unknown>,
): Promise<string | null> {
  for (const sp of collectEntrySubpathCandidates(pkgJson)) {
    const abs = resolve(packageRoot, sp);
    const hit = await resolveExistingModule(abs);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve every entry the package surfaces (import / require / default / types
 * conditions plus legacy `main` / `module` / `types`) onto disk. Returns the
 * absolute paths in the order produced by {@link collectEntrySubpathCandidates},
 * deduped. Dual-bundle packages (ESM + CJS + types) expose several entries; the
 * barrel pruner traces each one so none of them are accidentally dropped.
 */
export async function resolveAllPackageEntries(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
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

const DISCOVERY_SKIP_DIRS = new Set(["node_modules", ".git", ".hg"]);
const DISCOVERY_MAX_DEPTH = 6;

async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/** True when `candidate` lies under `ancestor` (canonical paths, strict subpath). */
async function isCanonicalDescendantOf(
  ancestor: string,
  candidate: string,
): Promise<boolean> {
  const base = await canonicalPath(ancestor);
  const cand = await canonicalPath(candidate);
  const rel = relative(base, cand).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return false;
  return !rel.split("/").includes("..");
}

function resolveConfigPath(projectRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(projectRoot, p);
}

/**
 * If `pathConfig` is a package root with matching `package.json#name` and a
 * resolvable entry, return it; otherwise null (no warnings).
 */
async function tryResolvePackageEntryAtPath(
  projectRoot: string,
  pathConfig: string,
  expectedName: string,
): Promise<{ root: string; pkgJson: Record<string, unknown> } | null> {
  const abs = resolveConfigPath(projectRoot, pathConfig);
  if (!(await isDirectory(abs))) return null;
  const pkgPath = resolve(abs, "package.json");
  if (!(await pathExists(pkgPath))) return null;
  try {
    const pj = JSON.parse(
      await readFile(pkgPath, "utf-8"),
    ) as Record<string, unknown>;
    if (pj.name !== expectedName) return null;
    if (!(await resolvePackageEntryAbs(abs, pj))) return null;
    return { root: abs, pkgJson: pj };
  } catch {
    return null;
  }
}

/**
 * Bounded depth-first search under `searchRoot` (skips `node_modules` / VCS dirs)
 * for a directory whose `package.json` `name` matches `expectedName` and whose
 * package entry resolves on disk.
 */
async function findClosestPackageDescendant(
  searchRoot: string,
  expectedName: string,
): Promise<{ root: string; pkgJson: Record<string, unknown> } | null> {
  async function walk(
    dir: string,
    depth: number,
  ): Promise<{ root: string; pkgJson: Record<string, unknown> } | null> {
    if (depth > DISCOVERY_MAX_DEPTH) return null;
    const pkgPath = resolve(dir, "package.json");
    if (await pathExists(pkgPath)) {
      try {
        const pj = JSON.parse(
          await readFile(pkgPath, "utf-8"),
        ) as Record<string, unknown>;
        if (pj.name === expectedName) {
          if (await resolvePackageEntryAbs(dir, pj))
            return { root: dir, pkgJson: pj };
        }
      } catch {
        // ignore
      }
    }
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    for (const name of entries) {
      if (DISCOVERY_SKIP_DIRS.has(name)) continue;
      const sub = resolve(dir, name);
      if (!(await isDirectory(sub))) continue;
      const hit = await walk(sub, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  let entries: string[] = [];
  try {
    entries = await readdir(searchRoot);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (DISCOVERY_SKIP_DIRS.has(name)) continue;
    const sub = resolve(searchRoot, name);
    if (!(await isDirectory(sub))) continue;
    const hit = await walk(sub, 1);
    if (hit) return hit;
  }
  return null;
}

async function tryApplyEntryPaths(
  projectRoot: string,
  entry: string | string[] | undefined,
  expectedName: string,
): Promise<
  | { ok: true; root: string; pkgJson: Record<string, unknown> }
  | { ok: false; warnings: string[] }
> {
  if (entry === undefined) return { ok: false, warnings: [] };

  const paths = (Array.isArray(entry) ? entry : [entry])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (paths.length === 0) return { ok: false, warnings: [] };

  const silentMiss = Array.isArray(entry);

  for (const p of paths) {
    const hit = await tryResolvePackageEntryAtPath(projectRoot, p, expectedName);
    if (hit) return { ok: true, ...hit };
  }

  if (silentMiss || paths.length > 1) {
    return { ok: false, warnings: [] };
  }

  const entryConfig = paths[0]!;
  const abs = resolveConfigPath(projectRoot, entryConfig);
  if (!(await isDirectory(abs))) {
    return { ok: false, warnings: [`entry path is not a directory: ${entryConfig}`] };
  }
  const pkgPath = resolve(abs, "package.json");
  if (!(await pathExists(pkgPath))) {
    return { ok: false, warnings: [`entry path has no package.json: ${entryConfig}`] };
  }
  try {
    const pj = JSON.parse(
      await readFile(pkgPath, "utf-8"),
    ) as Record<string, unknown>;
    if (pj.name !== expectedName) {
      return {
        ok: false,
        warnings: [
          `entry package.json "name" is "${String(pj.name)}" but target is "${expectedName}"`,
        ],
      };
    }
    return {
      ok: false,
      warnings: [
        `Could not resolve a package entry from entry root: ${entryConfig}`,
      ],
    };
  } catch {
    return {
      ok: false,
      warnings: [`Could not read package.json under entry: ${entryConfig}`],
    };
  }
}

/**
 * Resolve which directory + package.json to use for layout/namespace:
 * 1. Config `entry` (string or string[]; merged with preset `entry` in the resolver), if any
 * 2. Default `node_modules` install root
 * 3. Bounded nested match under the install root (name + resolvable entry)
 * 4. Bounded match elsewhere under the project (same rules), skipped when the
 *    install root is already a non-`node_modules` path inside the project (avoids
 *    duplicating the same tree walk for workspace-linked packages)
 */
async function discoverPackageInspectContext(
  projectRoot: string,
  installRoot: string,
  expectedName: string,
  initialPkgJson: Record<string, unknown>,
  entry?: string | string[],
): Promise<{
  contentRoot: string;
  pkgJson: Record<string, unknown>;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let contentRoot = installRoot;
  let pkgJson = initialPkgJson;

  if (entry !== undefined) {
    const applied = await tryApplyEntryPaths(projectRoot, entry, expectedName);
    if (applied.ok) {
      contentRoot = applied.root;
      pkgJson = applied.pkgJson;
    } else {
      warnings.push(...applied.warnings);
    }
  }

  let entryAbs = await resolvePackageEntryAbs(contentRoot, pkgJson);

  if (!entryAbs) {
    const nested = await findClosestPackageDescendant(installRoot, expectedName);
    if (nested) {
      contentRoot = nested.root;
      pkgJson = nested.pkgJson;
      entryAbs = await resolvePackageEntryAbs(contentRoot, pkgJson);
    }
  }

  if (!entryAbs) {
    const nmRoot = resolve(projectRoot, "node_modules");
    const installInsideProject = await isCanonicalDescendantOf(
      projectRoot,
      installRoot,
    );
    const installUnderNodeModules = await isCanonicalDescendantOf(
      nmRoot,
      installRoot,
    );
    const skipProjectTreeFallback =
      installInsideProject && !installUnderNodeModules;

    if (!skipProjectTreeFallback) {
      const fromProject = await findClosestPackageDescendant(
        projectRoot,
        expectedName,
      );
      if (fromProject) {
        const rel = relative(projectRoot, fromProject.root).replace(/\\/g, "/");
        warnings.push(
          `Resolved "${expectedName}" from "${rel}" (bounded project search) because the install root had no resolvable package entry.`,
        );
        contentRoot = fromProject.root;
        pkgJson = fromProject.pkgJson;
        entryAbs = await resolvePackageEntryAbs(contentRoot, pkgJson);
      }
    }
  }

  return { contentRoot, pkgJson, warnings };
}

export type DetectPackageOptions = {
  /**
   * Merged user + preset package root(s). A string uses strict miss warnings; an
   * array tries each path in order with silent misses (see `mergeEntryForDetect`).
   */
  entry?: string | string[];
};

/** Resolve symlinked `node_modules/<pkg>` to its physical path for layout scans. */
async function inspectionPackageRoot(packageDir: string): Promise<string> {
  try {
    return await realpath(packageDir);
  } catch {
    return packageDir;
  }
}

async function isSymbolicLinkPath(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function detectPackageConfig(
  target: string,
  projectRoot: string,
  options: DetectPackageOptions = {},
): Promise<DetectedConfig> {
  const packageDir = resolve(projectRoot, "node_modules", target);
  const warnings: string[] = [];

  const installedInNodeModules = await pathExists(packageDir);
  if (!installedInNodeModules && !options.entry) {
    return {
      patterns: {},
      packageStructure: {},
      confidence: "low",
      warnings: [
        `Package "${target}" not found in node_modules. Auto-detection skipped.`,
      ],
    };
  }

  let pkgJson: Record<string, unknown> = {};
  if (installedInNodeModules) {
    try {
      pkgJson = JSON.parse(
        await readFile(resolve(packageDir, "package.json"), "utf-8"),
      ) as Record<string, unknown>;
    } catch {
      warnings.push(`Could not read package.json for ${target}.`);
    }
  }

  const preset = matchPreset(target);
  const installRoot = installedInNodeModules
    ? await inspectionPackageRoot(packageDir)
    : projectRoot;

  const discovered = await discoverPackageInspectContext(
    projectRoot,
    installRoot,
    target,
    pkgJson,
    options.entry,
  );
  warnings.push(...discovered.warnings);
  const { contentRoot, pkgJson: workingPkgJson } = discovered;

  if (!(await resolvePackageEntryAbs(contentRoot, workingPkgJson))) {
    return {
      patterns: {},
      packageStructure: {},
      confidence: "low",
      skip: true,
      warnings: [
        ...warnings,
        `Could not resolve package entry for "${target}" after config entry path(s), install root, nested install search, and bounded project search — skipping.`,
      ],
    };
  }

  const { layoutRoot, layout: pickedLayout } =
    await pickLayoutInspectionRoot(contentRoot, workingPkgJson);
  let layout = pickedLayout;

  // Hoisted installs often expose `node_modules/<pkg>` as a symlink (pnpm store,
  // etc.); if layout still reads as "barrel" but a matched preset declares a
  // concrete structure, trust the preset for that hoisted link.
  //
  // Only apply this when the preset's member tree actually exists on disk
  // (under the package root and/or under the resolved entry directory — e.g.
  // `dist/models`). Otherwise we pick `nested` + `models` from the Gadget preset
  // while the mirrored cache has no matching tree, and nested prune warns / no-ops.
  const symlinkHoistLikely =
    installedInNodeModules && (await isSymbolicLinkPath(packageDir));
  const presetLayout = preset?.packageStructure?.layout;
  if (
    layout === "barrel" &&
    symlinkHoistLikely &&
    presetLayout &&
    presetLayout !== "barrel"
  ) {
    const roots =
      layoutRoot === installRoot ? [installRoot] : [installRoot, layoutRoot];
    for (const r of roots) {
      const memberDirForPreset =
        (await detectMemberDir(r, presetLayout)) ??
        preset?.packageStructure?.memberDir;
      const memberTreeRoot =
        memberDirForPreset && memberDirForPreset !== "."
          ? resolve(r, memberDirForPreset)
          : r;
      if (await isDirectory(memberTreeRoot)) {
        layout = presetLayout;
        break;
      }
    }
  }

  const rawMemberDir = await detectMemberDir(layoutRoot, layout);
  const structureRoot = contentRoot;
  const memberDir = await rebaselineMemberDirToPackageRoot(
    structureRoot,
    layoutRoot,
    rawMemberDir,
    layout,
  );
  const { namespace, exportedMembers } = await detectNamespace(
    contentRoot,
    workingPkgJson,
  );
  const { hooks } = await detectMemberShape(
    structureRoot,
    layout,
    memberDir,
    exportedMembers,
  );
  const naming = await detectNaming(structureRoot, layout, memberDir);
  const extensions = await detectExtensions(structureRoot, layout, memberDir);

  // For destructure-style packages, the scanner relies on import tracking,
  // not on a single namespace identifier — so a missing namespace is fine.
  const namespaceRequired = layout !== "destructure";
  if (namespaceRequired && !namespace && !preset?.patterns?.namespace) {
    warnings.push(
      `Could not infer namespace for ${target}. Add patterns.namespace to your config.`,
    );
  }
  if (layout === "barrel") {
    warnings.push(
      `${target} is a barrel package — pkg-optimize will trace static re-exports from the package entry, prune unused modules, and rewrite barrel files when analysis succeeds.`,
    );
  }

  const patterns: Partial<PatternsConfig> = {
    namespace: namespace ?? preset?.patterns?.namespace,
    accessStyle: "member",
    depth: { member: 1, operation: 2 },
    hooks: hooks.length > 0 ? hooks : preset?.patterns?.hooks,
  };

  const packageStructure: Partial<StructureConfig> = {
    layout: layout ?? preset?.packageStructure?.layout,
    memberDir: memberDir ?? preset?.packageStructure?.memberDir,
    operationDir: preset?.packageStructure?.operationDir,
    naming: naming ?? preset?.packageStructure?.naming,
    extensions:
      extensions.length > 0
        ? extensions
        : preset?.packageStructure?.extensions ?? [".js", ".d.ts"],
    preserve: preset?.packageStructure?.preserve ?? DEFAULT_PRESERVE,
  };

  // Destructure packages don't need a namespace or hook patterns; their
  // confidence is judged purely on layout/structure inference.
  const confidence =
    layout === "destructure"
      ? scoreConfidence({
          layout: packageStructure.layout,
          memberDir: packageStructure.memberDir,
          naming: packageStructure.naming,
          extensions: packageStructure.extensions?.length ? "yes" : null,
        })
      : scoreConfidence({
          namespace: patterns.namespace,
          layout: packageStructure.layout,
          memberDir: packageStructure.memberDir,
          naming: packageStructure.naming,
          hooks: patterns.hooks?.length ? "yes" : null,
          preset: preset ? "yes" : null,
        });

  if (confidence === "low") {
    warnings.push(
      `Low confidence detection for ${target}. Review the detected snapshot under your cache dir (default: .pkg-optimize-cache/_detected.json) and add explicit overrides in your config if needed.`,
    );
  }

  return { patterns, packageStructure, confidence, warnings };
}

export async function detectLayout(
  packageDir: string,
  opts: { allowDestructure?: boolean } = {},
): Promise<StructureConfig["layout"]> {
  let entries: string[] = [];
  try {
    entries = await readdir(packageDir);
  } catch {
    return "barrel";
  }

  const dirChecks = await Promise.all(
    entries.map(async (name) => ({
      name,
      isDir: await isDirectory(resolve(packageDir, name)),
    })),
  );
  const dirEntries = dirChecks.reduce<string[]>((acc, d) => {
    if (d.isDir) acc.push(d.name);
    return acc;
  }, []);

  const memberDirName = KNOWN_MEMBER_DIRS.find((c) => dirEntries.includes(c));

  if (memberDirName) {
    const memberDirPath = resolve(packageDir, memberDirName);
    let memberEntries: string[] = [];
    try {
      memberEntries = await readdir(memberDirPath);
    } catch {
      return "flat";
    }

    const memberDirChecks = await Promise.all(
      memberEntries.map((name) => isDirectory(resolve(memberDirPath, name))),
    );
    const hasNestedDirs = memberDirChecks.some(Boolean);

    return hasNestedDirs ? "nested" : "flat";
  }

  // No known member dir. The package itself might be the member dir
  // (`lodash-es`, `date-fns`, `react-icons/fa`, `@radix-ui/*`, etc.) — i.e.
  // each top-level file or subdir is an independently-importable export.
  //
  // Callers that have already resolved the package's entry into a subdir
  // (e.g. `dist-esm/index.js`) pass `allowDestructure: false` for this root,
  // because the root's siblings of that subdir are typically build-output
  // peers (`dist-cjs/`, `types/`, `src/`, …), not destructure exports.
  if (
    opts.allowDestructure !== false &&
    (await looksDestructureStyle(packageDir, entries, dirEntries))
  ) {
    return "destructure";
  }

  return "barrel";
}

async function pickLayoutInspectionRoot(
  inspectRoot: string,
  pkgJson: Record<string, unknown>,
): Promise<{
  layoutRoot: string;
  layout: StructureConfig["layout"];
}> {
  const entryAbs = await resolvePackageEntryAbs(inspectRoot, pkgJson);
  let entryDir: string | null = null;
  if (entryAbs) {
    const rel = relative(inspectRoot, entryAbs).replace(/\\/g, "/");
    const entryInsidePkg = !!rel && !rel.startsWith("..");
    const d = dirname(entryAbs);
    if (entryInsidePkg && d !== inspectRoot) entryDir = d;
  }

  // When the package entry is bundled into a subdir (e.g. `dist-esm/index.js`)
  // the entry's parent dir is the meaningful "layout root" — its siblings are
  // the actual code units. The package root's siblings of that subdir are
  // typically build-output peers (`dist-cjs/`, `types/`, `src/`, …) so we must
  // not let the destructure heuristic fire there, or it will treat every
  // top-level directory as a removable destructure member.
  const candidates: Array<{ root: string; allowDestructure: boolean }> = [];
  if (entryDir) {
    candidates.push({ root: entryDir, allowDestructure: true });
    candidates.push({ root: inspectRoot, allowDestructure: false });
  } else {
    candidates.push({ root: inspectRoot, allowDestructure: true });
  }

  let layout: StructureConfig["layout"] = "barrel";
  for (const { root, allowDestructure } of candidates) {
    layout = await detectLayout(root, { allowDestructure });
    if (layout !== "barrel") return { layoutRoot: root, layout };
  }
  return { layoutRoot: entryDir ?? inspectRoot, layout };
}

async function looksDestructureStyle(
  packageDir: string,
  entries: string[],
  dirEntries: string[],
): Promise<boolean> {
  const codeFileCount = entries.filter(
    (n) =>
      isCodeFile(n) &&
      n !== "index.js" &&
      n !== "index.mjs" &&
      n !== "index.cjs",
  ).length;
  const subdirCount = dirEntries.filter(
    (n) => !n.startsWith(".") && n !== "node_modules",
  ).length;

  // Heuristic: at least 4 sibling exportable units at the package root.
  if (codeFileCount + subdirCount < 4) return false;

  // If there's an index.* file, check that it's a barrel re-export rather than
  // the actual implementation (the latter would be a true "barrel" package).
  const indexFile = ["index.mjs", "index.js", "index.cjs"].find((n) =>
    entries.includes(n),
  );
  if (indexFile) {
    let source = "";
    try {
      source = await readFile(resolve(packageDir, indexFile), "utf-8");
    } catch {
      return false;
    }
    const reexportLines = (
      source.match(/export[^;]*from\s+['"]\.[^'"]+['"]/g) ?? []
    ).length;
    if (reexportLines >= 4) return true;
    if (reexportLines === 0) return false;
  }

  return true;
}

function isCodeFile(name: string): boolean {
  return /\.(m?js|c?js|d\.ts|d\.mts|d\.cts|ts|tsx)$/.test(name);
}

export async function detectMemberDir(
  packageDir: string,
  layout: StructureConfig["layout"],
): Promise<string | undefined> {
  if (layout === "barrel") return undefined;
  if (layout === "destructure") return ".";
  const checks = await Promise.all(
    KNOWN_MEMBER_DIRS.map(async (c) => ({
      c,
      isDir: await isDirectory(resolve(packageDir, c)),
    })),
  );
  return checks.find((x) => x.isDir)?.c;
}

async function rebaselineMemberDirToPackageRoot(
  inspectRoot: string,
  layoutRoot: string,
  raw: string | undefined,
  layout: StructureConfig["layout"],
): Promise<string | undefined> {
  if (layout === "barrel" || !raw || raw === ".") return raw;
  if (layoutRoot === inspectRoot) return raw;
  const abs = resolve(layoutRoot, raw);
  const rel = relative(inspectRoot, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) {
    return (await detectMemberDir(inspectRoot, layout)) ?? undefined;
  }
  return rel;
}

export async function detectExtensions(
  packageDir: string,
  layout: StructureConfig["layout"],
  memberDir: string | undefined,
): Promise<string[]> {
  const targetDir =
    layout === "barrel" || !memberDir || memberDir === "."
      ? packageDir
      : resolve(packageDir, memberDir);

  let entries: string[] = [];
  try {
    entries = await readdir(targetDir);
  } catch {
    return [];
  }

  const exts = new Set<string>();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const s = await stat(resolve(targetDir, entry));
        if (s.isFile()) {
          const ext = entry.endsWith(".d.ts") ? ".d.ts" : extname(entry);
          if (ext) exts.add(ext);
        }
      } catch {
        // ignore
      }
    }),
  );

  const allowed = new Set([".js", ".mjs", ".cjs", ".d.ts", ".d.mts", ".d.cts"]);
  return [...exts].filter((e) => allowed.has(e));
}

export async function detectNaming(
  packageDir: string,
  layout: StructureConfig["layout"],
  memberDir: string | undefined,
): Promise<StructureConfig["naming"] | undefined> {
  const samples = await sampleFilenames(packageDir, layout, memberDir, 10);
  if (samples.length === 0) return undefined;

  const scores: Record<StructureConfig["naming"], number> = {
    PascalCase: 0,
    camelCase: 0,
    "kebab-case": 0,
    snake_case: 0,
  };

  for (const name of samples) {
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) scores.PascalCase++;
    else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) scores.camelCase++;
    else if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) scores["kebab-case"]++;
    else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) scores.snake_case++;
    else if (/^[a-z][a-z0-9]*$/.test(name)) {
      // Single-segment lowercase counts toward both kebab and camel; favor camel.
      scores.camelCase++;
    }
  }

  const sorted = (
    Object.entries(scores) as Array<[StructureConfig["naming"], number]>
  ).sort(([, a], [, b]) => b - a);
  const [best, bestScore] = sorted[0]!;
  if (bestScore === 0) return undefined;
  return best;
}

export async function sampleFilenames(
  packageDir: string,
  layout: StructureConfig["layout"],
  memberDir: string | undefined,
  count: number,
): Promise<string[]> {
  if (layout === "barrel") return [];
  if (!memberDir) return [];

  const dir = memberDir === "." ? packageDir : resolve(packageDir, memberDir);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    try {
      const s = await stat(resolve(dir, entry));
      let base: string;
      if (s.isDirectory()) {
        base = entry;
      } else if (s.isFile()) {
        base = stripExtension(entry);
      } else {
        continue;
      }
      if (["index", "types"].includes(base)) continue;
      names.push(base);
      if (names.length >= count) break;
    } catch {
      // ignore
    }
  }
  return names;
}

function stripExtension(filename: string): string {
  // Source map sidecars (`Foo.js.map`, `Foo.d.ts.map`, …) share the stem of
  // their parent file — strip the trailing `.map` first so naming detection
  // doesn't sample a fake stem like `Foo.js`.
  if (filename.endsWith(".map") && filename.length > 4) {
    const inner = filename.slice(0, -4);
    if (
      inner.endsWith(".js") ||
      inner.endsWith(".mjs") ||
      inner.endsWith(".cjs") ||
      inner.endsWith(".d.ts") ||
      inner.endsWith(".d.mts") ||
      inner.endsWith(".d.cts")
    ) {
      return stripExtension(inner);
    }
  }
  if (filename.endsWith(".d.ts")) return filename.slice(0, -5);
  if (filename.endsWith(".d.mts")) return filename.slice(0, -6);
  if (filename.endsWith(".d.cts")) return filename.slice(0, -6);
  return basename(filename, extname(filename));
}

export async function detectNamespace(
  packageDir: string,
  pkgJson: Record<string, unknown>,
): Promise<{ namespace: string | undefined; exportedMembers: string[] }> {
  const entryFile = await resolvePackageEntryAbs(packageDir, pkgJson);
  if (!entryFile) return { namespace: undefined, exportedMembers: [] };

  let source = "";
  try {
    source = await readFile(entryFile, "utf-8");
  } catch {
    return { namespace: undefined, exportedMembers: [] };
  }

  const namespace =
    extractFirstMatch(source, /export\s+const\s+([a-zA-Z_$][\w$]*)\s*=/) ??
    extractFirstMatch(source, /exports\.([a-zA-Z_$][\w$]*)\s*=/) ??
    extractFirstMatch(source, /module\.exports\s*=\s*\{?\s*([a-zA-Z_$][\w$]*)/);

  const exportedMembers = extractExportedNames(source);

  return { namespace, exportedMembers };
}

function extractFirstMatch(source: string, regex: RegExp): string | undefined {
  const match = regex.exec(source);
  return match?.[1];
}

function extractExportedNames(source: string): string[] {
  const names = new Set<string>();
  const constRe =
    /export\s+(?:const|let|var|function|class)\s+([a-zA-Z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = constRe.exec(source)) !== null) {
    names.add(match[1]!);
  }
  const namedRe = /export\s*\{\s*([^}]+)\}/g;
  while ((match = namedRe.exec(source)) !== null) {
    for (const n of match[1]!
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0]!)) {
      if (n) names.add(n);
    }
  }
  return [...names];
}

export async function detectMemberShape(
  packageDir: string,
  layout: StructureConfig["layout"],
  memberDir: string | undefined,
  _exportedMembers: string[],
): Promise<{ methods: string[]; hooks: HookPattern[] }> {
  if (layout === "barrel" || !memberDir) {
    return { methods: [], hooks: [] };
  }

  const sample = await pickMemberFile(packageDir, layout, memberDir);
  if (!sample) return { methods: [], hooks: [] };

  let source = "";
  try {
    source = await readFile(sample, "utf-8");
  } catch {
    return { methods: [], hooks: [] };
  }

  const methods = new Set<string>();
  const methodRe = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(source)) !== null) {
    methods.add(m[1]!);
  }

  const hooks: HookPattern[] = [];
  const hookRe = /(?:export\s+(?:const|function)\s+)(use[A-Z][a-zA-Z0-9]*)/g;
  while ((m = hookRe.exec(source)) !== null) {
    const name = m[1]!;
    if (hooks.some((h) => h.name === name)) continue;
    hooks.push({
      name,
      argIndex: 0,
      argStyle: "namespace-member",
    });
  }

  return { methods: [...methods], hooks };
}

async function pickMemberFile(
  packageDir: string,
  layout: StructureConfig["layout"],
  memberDir: string,
): Promise<string | null> {
  const dir = resolve(packageDir, memberDir);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    try {
      const full = resolve(dir, entry);
      const s = await stat(full);
      if (s.isFile() && (entry.endsWith(".js") || entry.endsWith(".mjs"))) {
        return full;
      }
      if (s.isDirectory() && layout === "nested") {
        const nestedEntries = await readdir(full);
        const candidate = nestedEntries.find(
          (name) => name.endsWith(".js") || name.endsWith(".mjs"),
        );
        if (candidate) return resolve(full, candidate);
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function scoreConfidence(
  inputs: Record<string, unknown>,
): DetectedConfig["confidence"] {
  const total = Object.values(inputs).length;
  const defined = Object.values(inputs).filter(
    (v) => v !== null && v !== undefined && v !== "",
  ).length;
  if (total === 0) return "low";
  const ratio = defined / total;
  if (ratio >= 0.9) return "high";
  if (ratio >= 0.6) return "medium";
  return "low";
}
