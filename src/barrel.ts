import { parse } from "@babel/parser";
import type { ParserOptions } from "@babel/parser";
import type { File, StringLiteral } from "@babel/types";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { resolveAllPackageEntries, resolveExistingModule } from "./detector/entries";
import { toCamelCase } from "./utils";

export interface BarrelPlan {
  ok: true;
  keepRelPaths: Set<string>;
  barrelRelPaths: Set<string>;
}

export interface BarrelPlanError {
  ok: false;
  reason: string;
}

export type BarrelAnalyzeResult = BarrelPlan | BarrelPlanError;

const PARSE_OPTS: ParserOptions = {
  sourceType: "module" as const,
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  errorRecovery: true,
  plugins: ["typescript", "jsx", "decorators-legacy"],
};

const RESOLVE_EXTS = [
  ".js",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".d.mts",
  ".d.cts",
] as const;

/**
 * Build the set of files to keep and barrel files to rewrite for a multi-file
 * re-export package. Single-file packages yield keep = { entry } only.
 *
 * Dual-build packages (ESM + CJS + standalone `.d.ts` types — common for
 * generated SDK clients like `@gadget-client/*`) expose several entries through
 * the conditional `exports` map. We resolve every condition (`import`,
 * `require`, `default`, `types`) plus the legacy `main` / `module` / `types`
 * fields and trace each — otherwise pruning would keep only the first resolved
 * entry (typically the ESM bundle) and silently delete the CJS / `.d.ts`
 * siblings that bundlers and type-checkers depend on.
 */
export async function analyzeBarrelPackage(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
  /** camelCase member keys from the scanner + allow list */
  allowedCamelMembers: Set<string>,
  /** Normalized file refs (subpaths after package name) from deep imports */
  allowedFileRefs: Set<string>,
  signal?: AbortSignal,
): Promise<BarrelAnalyzeResult> {
  signal?.throwIfAborted();
  const entryAbsPaths = await resolveAllPackageEntries(packageRoot, pkgJson);
  if (entryAbsPaths.length === 0) {
    return {
      ok: false,
      reason: "Could not resolve package entry file from package.json.",
    };
  }

  const keepRelPaths = new Set<string>();
  const visitedBarrels = new Set<string>();

  keepRelPaths.add("package.json");

  for (const ref of allowedFileRefs) {
    const n = ref.replace(/^\.?\/+/, "").replace(/\\/g, "/");
    if (!n || n.includes("..")) continue;
    keepRelPaths.add(n);
    for (const ext of RESOLVE_EXTS) {
      keepRelPaths.add(`${n}${ext}`);
    }
  }

  for (const entryAbs of entryAbsPaths) {
    signal?.throwIfAborted();
    const entryRel = toPosixRel(packageRoot, entryAbs);
    keepRelPaths.add(entryRel);

    // Each entry must at least survive. If it can't be parsed (e.g. a minified
    // CJS bundle that confuses Babel) we keep the file itself and continue —
    // refusing to prune is safer than failing the whole package.
    let entrySource: string;
    try {
      entrySource = await readFile(entryAbs, "utf-8");
    } catch {
      continue;
    }

    try {
      parse(entrySource, { ...PARSE_OPTS, sourceFilename: entryRel });
    } catch {
      continue;
    }

    const surface = await collectExportSurface(
      packageRoot,
      entryAbs,
      new Map(),
      new Set(),
      signal,
    );
    if (!surface.ok) return surface;

    const neededExportNames = new Set<string>();
    for (const name of surface.names) {
      if (allowedCamelMembers.has(toCamelCase(name))) {
        neededExportNames.add(name);
      }
    }

    // (Falling through with an empty neededExportNames is intentional: a
    // package that's only deep-imported still gets pruned down to entries +
    // package.json + the explicit allowed file refs.)

    for (const name of neededExportNames) {
      const traced = await traceExport(
        packageRoot,
        entryAbs,
        name,
        new Set(),
        signal,
      );
      if (!traced.ok) return traced;
      for (const p of traced.implRelPaths) keepRelPaths.add(p);
      for (const p of traced.visitedRelPaths) {
        visitedBarrels.add(p);
        keepRelPaths.add(p);
      }
    }
  }

  const barrelRelPaths = new Set<string>();
  for (const rel of visitedBarrels) {
    const abs = resolvePath(packageRoot, rel);
    const kind = await classifyModuleAt(abs, signal);
    if (kind === "barrel") barrelRelPaths.add(rel);
  }

  return { ok: true, keepRelPaths, barrelRelPaths };
}

function toPosixRel(root: string, abs: string): string {
  return relative(root, abs)
    .split(/[/\\]+/)
    .join("/");
}

async function resolveRelativeModule(
  packageRoot: string,
  fromFileAbs: string,
  specifier: string,
): Promise<string | null> {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }
  const base = resolvePath(dirname(fromFileAbs), specifier);
  return resolveExistingModule(base);
}

type SurfaceResult =
  | { ok: true; names: Set<string> }
  | { ok: false; reason: string };

async function collectExportSurface(
  packageRoot: string,
  moduleAbs: string,
  memo: Map<string, Set<string>>,
  inProgress: Set<string>,
  signal?: AbortSignal,
): Promise<SurfaceResult> {
  signal?.throwIfAborted();
  const rel = toPosixRel(packageRoot, moduleAbs);
  const cached = memo.get(rel);
  if (cached) return { ok: true, names: new Set(cached) };
  if (inProgress.has(rel)) return { ok: true, names: new Set() };
  inProgress.add(rel);

  let source: string;
  try {
    source = await readFile(moduleAbs, "utf-8");
  } catch {
    inProgress.delete(rel);
    return { ok: false, reason: `Could not read module ${rel}.` };
  }

  let ast: File;
  try {
    ast = parse(source, { ...PARSE_OPTS, sourceFilename: rel }) as File;
  } catch {
    inProgress.delete(rel);
    return { ok: false, reason: `Could not parse module ${rel}.` };
  }

  const names = new Set<string>();

  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
      const src = (stmt.source as StringLiteral).value;
      const resolved = await resolveRelativeModule(packageRoot, moduleAbs, src);
      if (!resolved) continue;
      for (const spec of stmt.specifiers) {
        if (spec.type === "ExportSpecifier") {
          const exported =
            spec.exported.type === "Identifier"
              ? spec.exported.name
              : spec.exported.value;
          names.add(exported);
        }
      }
    } else if (stmt.type === "ExportAllDeclaration") {
      const src = (stmt.source as StringLiteral).value;
      const resolved = await resolveRelativeModule(packageRoot, moduleAbs, src);
      if (!resolved) continue;
      const inner = await collectExportSurface(
        packageRoot,
        resolved,
        memo,
        inProgress,
        signal,
      );
      if (!inner.ok) {
        inProgress.delete(rel);
        return inner;
      }
      for (const n of inner.names) names.add(n);
    } else if (stmt.type === "ExportDefaultDeclaration") {
      names.add("default");
    } else if (stmt.type === "ExportNamedDeclaration" && !stmt.source) {
      for (const spec of stmt.specifiers) {
        if (spec.type === "ExportSpecifier") {
          const exported =
            spec.exported.type === "Identifier"
              ? spec.exported.name
              : spec.exported.value;
          names.add(exported);
        }
      }
      const decl = stmt.declaration;
      if (decl) {
        if (decl.type === "VariableDeclaration") {
          for (const d of decl.declarations) {
            if (d.id.type === "Identifier") names.add(d.id.name);
          }
        } else if (decl.type === "FunctionDeclaration" && decl.id) {
          names.add(decl.id.name);
        } else if (decl.type === "ClassDeclaration" && decl.id) {
          names.add(decl.id.name);
        } else if (
          decl.type === "TSTypeAliasDeclaration" &&
          decl.id.type === "Identifier"
        ) {
          names.add(decl.id.name);
        } else if (
          decl.type === "TSInterfaceDeclaration" &&
          decl.id.type === "Identifier"
        ) {
          names.add(decl.id.name);
        } else if (
          decl.type === "TSDeclareFunction" &&
          decl.id?.type === "Identifier"
        ) {
          names.add(decl.id.name);
        }
      }
    }
  }

  memo.set(rel, names);
  inProgress.delete(rel);
  return { ok: true, names };
}

type TraceResult =
  | { ok: true; implRelPaths: Set<string>; visitedRelPaths: Set<string> }
  | { ok: false; reason: string };

async function traceExport(
  packageRoot: string,
  moduleAbs: string,
  exportName: string,
  stack: Set<string>,
  signal?: AbortSignal,
): Promise<TraceResult> {
  signal?.throwIfAborted();
  const rel = toPosixRel(packageRoot, moduleAbs);
  const key = `${rel}#${exportName}`;
  if (stack.has(key)) {
    return { ok: true, implRelPaths: new Set(), visitedRelPaths: new Set() };
  }
  stack.add(key);

  const visitedRelPaths = new Set<string>([rel]);
  const implRelPaths = new Set<string>();

  let source: string;
  try {
    source = await readFile(moduleAbs, "utf-8");
  } catch {
    stack.delete(key);
    return {
      ok: false,
      reason: `Could not read ${rel} while tracing export "${exportName}".`,
    };
  }

  let ast: File;
  try {
    ast = parse(source, { ...PARSE_OPTS, sourceFilename: rel }) as File;
  } catch {
    stack.delete(key);
    return {
      ok: false,
      reason: `Could not parse ${rel} while tracing export "${exportName}".`,
    };
  }

  const modKind = classifyFromAst(ast);
  if (modKind.hasLocalExport(exportName)) {
    implRelPaths.add(rel);
    stack.delete(key);
    return { ok: true, implRelPaths, visitedRelPaths };
  }

  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
      const src = (stmt.source as StringLiteral).value;
      const resolved = await resolveRelativeModule(packageRoot, moduleAbs, src);
      if (!resolved) continue;
      for (const spec of stmt.specifiers) {
        if (spec.type !== "ExportSpecifier") continue;
        const exported =
          spec.exported.type === "Identifier"
            ? spec.exported.name
            : spec.exported.value;
        if (exported !== exportName) continue;
        const local =
          spec.local.type === "Identifier" ? spec.local.name : exported;
        const inner = await traceExport(
          packageRoot,
          resolved,
          local,
          stack,
          signal,
        );
        if (!inner.ok) {
          stack.delete(key);
          return inner;
        }
        for (const p of inner.implRelPaths) implRelPaths.add(p);
        for (const p of inner.visitedRelPaths) visitedRelPaths.add(p);
        stack.delete(key);
        return { ok: true, implRelPaths, visitedRelPaths };
      }
    }
  }

  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportAllDeclaration") {
      const src = (stmt.source as StringLiteral).value;
      const resolved = await resolveRelativeModule(packageRoot, moduleAbs, src);
      if (!resolved) continue;
      const inner = await traceExport(
        packageRoot,
        resolved,
        exportName,
        stack,
        signal,
      );
      if (
        inner.ok &&
        (inner.implRelPaths.size > 0 || inner.visitedRelPaths.size > 1)
      ) {
        for (const p of inner.implRelPaths) implRelPaths.add(p);
        for (const p of inner.visitedRelPaths) visitedRelPaths.add(p);
        stack.delete(key);
        return { ok: true, implRelPaths, visitedRelPaths };
      }
    }
  }

  stack.delete(key);
  return { ok: true, implRelPaths, visitedRelPaths };
}

/**
 * Whether this module declares `exportName` locally (not only re-exporting).
 */
function classifyFromAst(ast: File): { hasLocalExport(name: string): boolean } {
  const localNames = new Set<string>();

  for (const stmt of ast.program.body) {
    if (stmt.type === "ImportDeclaration") continue;
    if (stmt.type === "ExportNamedDeclaration" && stmt.source) continue;
    if (stmt.type === "ExportAllDeclaration") continue;

    if (stmt.type === "ExportDefaultDeclaration") {
      localNames.add("default");
      continue;
    }

    if (stmt.type === "ExportNamedDeclaration" && !stmt.source) {
      for (const spec of stmt.specifiers) {
        if (spec.type === "ExportSpecifier") {
          const exported =
            spec.exported.type === "Identifier"
              ? spec.exported.name
              : spec.exported.value;
          localNames.add(exported);
        }
      }
      const decl = stmt.declaration;
      if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id.type === "Identifier") localNames.add(d.id.name);
        }
      } else if (decl?.type === "FunctionDeclaration" && decl.id) {
        localNames.add(decl.id.name);
      } else if (decl?.type === "ClassDeclaration" && decl.id) {
        localNames.add(decl.id.name);
      } else if (
        decl?.type === "TSTypeAliasDeclaration" &&
        decl.id.type === "Identifier"
      ) {
        localNames.add(decl.id.name);
      } else if (
        decl?.type === "TSInterfaceDeclaration" &&
        decl.id.type === "Identifier"
      ) {
        localNames.add(decl.id.name);
      } else if (
        decl?.type === "TSDeclareFunction" &&
        decl.id?.type === "Identifier"
      ) {
        localNames.add(decl.id.name);
      }
      continue;
    }

    if (stmt.type === "VariableDeclaration" && stmt.kind !== undefined) {
      for (const d of stmt.declarations) {
        if (d.id.type === "Identifier") localNames.add(d.id.name);
      }
    } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
      localNames.add(stmt.id.name);
    } else if (stmt.type === "ClassDeclaration" && stmt.id) {
      localNames.add(stmt.id.name);
    } else if (
      stmt.type === "TSTypeAliasDeclaration" &&
      stmt.id.type === "Identifier"
    ) {
      localNames.add(stmt.id.name);
    } else if (
      stmt.type === "TSInterfaceDeclaration" &&
      stmt.id.type === "Identifier"
    ) {
      localNames.add(stmt.id.name);
    } else if (
      stmt.type === "TSDeclareFunction" &&
      stmt.id?.type === "Identifier"
    ) {
      localNames.add(stmt.id.name);
    }
  }

  return {
    hasLocalExport(name: string): boolean {
      return localNames.has(name);
    },
  };
}

async function classifyModuleAt(
  abs: string,
  signal?: AbortSignal,
): Promise<"barrel" | "mixed"> {
  signal?.throwIfAborted();
  let source: string;
  try {
    source = await readFile(abs, "utf-8");
  } catch {
    return "mixed";
  }
  let ast: File;
  try {
    ast = parse(source, PARSE_OPTS) as File;
  } catch {
    return "mixed";
  }

  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportNamedDeclaration" && stmt.source) continue;
    if (stmt.type === "ExportAllDeclaration") continue;
    if (stmt.type === "ImportDeclaration") continue;

    if (stmt.type === "ExportDefaultDeclaration") return "mixed";
    if (stmt.type === "ExportNamedDeclaration" && !stmt.source) return "mixed";
    if (
      stmt.type === "VariableDeclaration" ||
      stmt.type === "FunctionDeclaration" ||
      stmt.type === "ClassDeclaration" ||
      stmt.type === "TSTypeAliasDeclaration" ||
      stmt.type === "TSInterfaceDeclaration" ||
      stmt.type === "TSDeclareFunction" ||
      stmt.type === "TSModuleDeclaration" ||
      stmt.type === "ExpressionStatement"
    ) {
      return "mixed";
    }
  }

  return "barrel";
}

/**
 * Rewrite a barrel file: drop named re-exports whose exported names are not in
 * `keepCamelNames`. When `opts` is set, `export * from` is kept only if some
 * file under the resolved target is still in `keepRelPaths`.
 */
export async function rewriteBarrelSource(
  source: string,
  keepCamelNames: Set<string>,
  opts?: {
    packageRoot: string;
    fileAbs: string;
    keepRelPaths: Set<string>;
  },
): Promise<{ ok: true; code: string } | { ok: false }> {
  let ast: File;
  try {
    ast = parse(source, PARSE_OPTS) as File;
  } catch {
    return { ok: false };
  }

  const kept: string[] = [];
  for (const stmt of ast.program.body) {
    if (stmt.type === "ImportDeclaration") {
      kept.push(sliceSource(source, stmt.start!, stmt.end!));
      continue;
    }
    if (stmt.type === "ExportAllDeclaration") {
      if (!opts) {
        kept.push(sliceSource(source, stmt.start!, stmt.end!));
        continue;
      }
      const src = (stmt.source as StringLiteral).value;
      const resolved = await resolveRelativeModule(
        opts.packageRoot,
        opts.fileAbs,
        src,
      );
      if (!resolved) continue;
      const rel = toPosixRel(opts.packageRoot, resolved);
      if (!keepSetCoversModulePath(rel, opts.keepRelPaths)) continue;
      kept.push(sliceSource(source, stmt.start!, stmt.end!));
      continue;
    }
    if (stmt.type === "ExportDefaultDeclaration") {
      kept.push(sliceSource(source, stmt.start!, stmt.end!));
      continue;
    }
    if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
      const srcNode = stmt.source as StringLiteral;
      const specParts: string[] = [];
      for (const spec of stmt.specifiers) {
        if (spec.type !== "ExportSpecifier") continue;
        const exported =
          spec.exported.type === "Identifier"
            ? spec.exported.name
            : spec.exported.value;
        if (!keepCamelNames.has(toCamelCase(exported))) continue;
        const slice = sliceSource(source, spec.start!, spec.end!).trim();
        specParts.push(slice);
      }
      if (specParts.length === 0) continue;
      const srcText = sliceSource(source, srcNode.start!, srcNode.end!);
      kept.push(`export { ${specParts.join(", ")} } from ${srcText};`);
      continue;
    }
    if (stmt.type === "ExportNamedDeclaration" && !stmt.source) {
      kept.push(sliceSource(source, stmt.start!, stmt.end!));
      continue;
    }
    if (
      stmt.type === "TSExportAssignment" ||
      stmt.type === "TSImportEqualsDeclaration"
    ) {
      kept.push(sliceSource(source, stmt.start!, stmt.end!));
      continue;
    }
  }

  const code = kept
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .join("\n");
  return { ok: true, code: code ? code + "\n" : "" };
}

function keepSetCoversModulePath(
  moduleRel: string,
  keep: Set<string>,
): boolean {
  const norm = moduleRel.replace(/\/+$/, "");
  if (keep.has(norm)) return true;
  const prefix = norm + "/";
  for (const k of keep) {
    if (k === norm || k.startsWith(prefix)) return true;
  }
  return false;
}

function sliceSource(source: string, start: number, end: number): string {
  return source.slice(start, end);
}
