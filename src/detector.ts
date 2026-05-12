import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { isDirectory, pathExists } from "./utils";
import type {
  DetectedConfig,
  HookPattern,
  PatternsConfig,
  StructureConfig,
} from "./types";
import { matchPreset } from "./presets/index";

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
  targetPackage: string,
  projectRoot: string,
): Promise<DetectedConfig> {
  const packageDir = resolve(projectRoot, "node_modules", targetPackage);
  const warnings: string[] = [];

  if (!(await pathExists(packageDir))) {
    return {
      patterns: {},
      packageStructure: {},
      confidence: "low",
      warnings: [
        `Package "${targetPackage}" not found in node_modules. Auto-detection skipped.`,
      ],
    };
  }

  let pkgJson: Record<string, unknown> = {};
  try {
    pkgJson = JSON.parse(
      await readFile(resolve(packageDir, "package.json"), "utf-8"),
    ) as Record<string, unknown>;
  } catch {
    warnings.push(`Could not read package.json for ${targetPackage}.`);
  }

  const preset = matchPreset(targetPackage);
  const inspectRoot = await inspectionPackageRoot(packageDir);

  let layout = await detectLayout(inspectRoot);

  // Hoisted installs often expose `node_modules/<pkg>` as a symlink (pnpm store,
  // etc.); if layout still reads as "barrel" but a matched preset declares a
  // concrete structure, trust the preset for that hoisted link.
  //
  // Only apply this when the preset's member tree actually exists on disk.
  // Otherwise we pick `nested` + `models` from the Gadget preset while the
  // mirrored cache has no `models/` (scanner still finds `api.*` usage from
  // source), and nested prune warns / no-ops.
  const symlinkHoistLikely = await isSymbolicLinkPath(packageDir);
  const presetLayout = preset?.packageStructure?.layout;
  if (
    layout === "barrel" &&
    symlinkHoistLikely &&
    presetLayout &&
    presetLayout !== "barrel"
  ) {
    const memberDirForPreset =
      (await detectMemberDir(inspectRoot, presetLayout)) ??
      preset?.packageStructure?.memberDir;
    const memberTreeRoot =
      memberDirForPreset && memberDirForPreset !== "."
        ? resolve(inspectRoot, memberDirForPreset)
        : inspectRoot;
    if (await isDirectory(memberTreeRoot)) {
      layout = presetLayout;
    }
  }

  const memberDir = await detectMemberDir(inspectRoot, layout);
  const { namespace, exportedMembers } = await detectNamespace(
    inspectRoot,
    pkgJson,
  );
  const { hooks } = await detectMemberShape(
    inspectRoot,
    layout,
    memberDir,
    exportedMembers,
  );
  const naming = await detectNaming(inspectRoot, layout, memberDir);
  const extensions = await detectExtensions(inspectRoot, layout, memberDir);

  // For destructure-style packages, the scanner relies on import tracking,
  // not on a single namespace identifier — so a missing namespace is fine.
  const namespaceRequired = layout !== "destructure";
  if (namespaceRequired && !namespace && !preset?.patterns?.namespace) {
    warnings.push(
      `Could not infer namespace for ${targetPackage}. Add patterns.namespace to your config.`,
    );
  }
  if (layout === "barrel") {
    warnings.push(
      `${targetPackage} is a barrel package — pkg-optimize will trace static re-exports from the package entry, prune unused modules, and rewrite barrel files when analysis succeeds.`,
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
      `Low confidence detection for ${targetPackage}. Review _detected in config and add explicit overrides if needed.`,
    );
  }

  return { patterns, packageStructure, confidence, warnings };
}

export async function detectLayout(
  packageDir: string,
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
  if (await looksDestructureStyle(packageDir, entries, dirEntries)) {
    return "destructure";
  }

  return "barrel";
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
  if (filename.endsWith(".d.ts")) return filename.slice(0, -5);
  if (filename.endsWith(".d.mts")) return filename.slice(0, -6);
  if (filename.endsWith(".d.cts")) return filename.slice(0, -6);
  return basename(filename, extname(filename));
}

export async function detectNamespace(
  packageDir: string,
  pkgJson: Record<string, unknown>,
): Promise<{ namespace: string | undefined; exportedMembers: string[] }> {
  const entryFile = await resolveEntryFile(packageDir, pkgJson);
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

async function resolveEntryFile(
  packageDir: string,
  pkgJson: Record<string, unknown>,
): Promise<string | null> {
  const candidates: string[] = [];
  const main = pkgJson.main as string | undefined;
  const moduleField = pkgJson.module as string | undefined;
  const types = pkgJson.types as string | undefined;
  if (moduleField) candidates.push(moduleField);
  if (main) candidates.push(main);
  if (types) candidates.push(types);
  candidates.push("index.js", "index.mjs", "index.cjs", "index.d.ts");

  for (const c of candidates) {
    const p = resolve(packageDir, c);
    if (await pathExists(p)) return p;
  }
  return null;
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
