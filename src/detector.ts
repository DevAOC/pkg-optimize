import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type {
  DetectedConfig,
  HookPattern,
  PatternsConfig,
  StructureConfig,
} from './types.js';
import { matchPreset } from './presets/index.js';

const DEFAULT_PRESERVE = [
  'index.js',
  'index.d.ts',
  'index.mjs',
  'index.cjs',
  'types.js',
  'types.d.ts',
  'package.json',
];

/**
 * Common folder names used by codegen tools to hold their per-member files.
 * Order matters: the first match wins.
 */
const KNOWN_MEMBER_DIRS = [
  'models',
  'operations',
  'queries',
  'resources',
  'routers',
  'endpoints',
  '__generated__',
  'hooks',
];

export async function detectPackageConfig(
  targetPackage: string,
  projectRoot: string,
): Promise<DetectedConfig> {
  const packageDir = resolve(projectRoot, 'node_modules', targetPackage);
  const warnings: string[] = [];

  if (!existsSync(packageDir)) {
    return {
      patterns: {},
      packageStructure: {},
      confidence: 'low',
      warnings: [
        `Package "${targetPackage}" not found in node_modules. Auto-detection skipped.`,
      ],
    };
  }

  let pkgJson: Record<string, unknown> = {};
  try {
    pkgJson = JSON.parse(
      readFileSync(resolve(packageDir, 'package.json'), 'utf-8'),
    ) as Record<string, unknown>;
  } catch {
    warnings.push(`Could not read package.json for ${targetPackage}.`);
  }

  const layout = detectLayout(packageDir);
  const memberDir = detectMemberDir(packageDir, layout);
  const { namespace, exportedMembers } = detectNamespace(packageDir, pkgJson);
  const { hooks } = detectMemberShape(packageDir, layout, memberDir, exportedMembers);
  const naming = detectNaming(packageDir, layout, memberDir);
  const extensions = detectExtensions(packageDir, layout, memberDir);
  const preset = matchPreset(targetPackage);

  // For destructure-style packages, the scanner relies on import tracking,
  // not on a single namespace identifier — so a missing namespace is fine.
  const namespaceRequired = layout !== 'destructure';
  if (namespaceRequired && !namespace && !preset?.patterns?.namespace) {
    warnings.push(
      `Could not infer namespace for ${targetPackage}. Add patterns.namespace to your config.`,
    );
  }
  if (layout === 'barrel') {
    warnings.push(
      `${targetPackage} appears to be a barrel package — file-level pruning is not supported. Will be skipped.`,
    );
  }

  const patterns: Partial<PatternsConfig> = {
    namespace: namespace ?? preset?.patterns?.namespace,
    accessStyle: 'member',
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
        : (preset?.packageStructure?.extensions ?? ['.js', '.d.ts']),
    preserve: preset?.packageStructure?.preserve ?? DEFAULT_PRESERVE,
  };

  // Destructure packages don't need a namespace or hook patterns; their
  // confidence is judged purely on layout/structure inference.
  const confidence =
    layout === 'destructure'
      ? scoreConfidence({
          layout: packageStructure.layout,
          memberDir: packageStructure.memberDir,
          naming: packageStructure.naming,
          extensions: packageStructure.extensions?.length ? 'yes' : null,
        })
      : scoreConfidence({
          namespace: patterns.namespace,
          layout: packageStructure.layout,
          memberDir: packageStructure.memberDir,
          naming: packageStructure.naming,
          hooks: patterns.hooks?.length ? 'yes' : null,
          preset: preset ? 'yes' : null,
        });

  if (confidence === 'low') {
    warnings.push(
      `Low confidence detection for ${targetPackage}. Review _detected in config and add explicit overrides if needed.`,
    );
  }

  return { patterns, packageStructure, confidence, warnings };
}

export function detectLayout(packageDir: string): StructureConfig['layout'] {
  let entries: string[] = [];
  try {
    entries = readdirSync(packageDir);
  } catch {
    return 'barrel';
  }

  const dirEntries = entries.filter((name) => {
    try {
      return statSync(resolve(packageDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  const memberDirName = KNOWN_MEMBER_DIRS.find((c) => dirEntries.includes(c));

  if (memberDirName) {
    const memberDirPath = resolve(packageDir, memberDirName);
    let memberEntries: string[] = [];
    try {
      memberEntries = readdirSync(memberDirPath);
    } catch {
      return 'flat';
    }

    const hasNestedDirs = memberEntries.some((name) => {
      try {
        return statSync(resolve(memberDirPath, name)).isDirectory();
      } catch {
        return false;
      }
    });

    return hasNestedDirs ? 'nested' : 'flat';
  }

  // No known member dir. The package itself might be the member dir
  // (`lodash-es`, `date-fns`, `react-icons/fa`, `@radix-ui/*`, etc.) — i.e.
  // each top-level file or subdir is an independently-importable export.
  if (looksDestructureStyle(packageDir, entries, dirEntries)) {
    return 'destructure';
  }

  return 'barrel';
}

function looksDestructureStyle(
  packageDir: string,
  entries: string[],
  dirEntries: string[],
): boolean {
  const codeFileCount = entries.filter((n) => isCodeFile(n) && n !== 'index.js' && n !== 'index.mjs' && n !== 'index.cjs').length;
  const subdirCount = dirEntries.filter((n) => !n.startsWith('.') && n !== 'node_modules').length;

  // Heuristic: at least 4 sibling exportable units at the package root.
  if (codeFileCount + subdirCount < 4) return false;

  // If there's an index.* file, check that it's a barrel re-export rather than
  // the actual implementation (the latter would be a true "barrel" package).
  const indexFile = ['index.mjs', 'index.js', 'index.cjs'].find((n) =>
    entries.includes(n),
  );
  if (indexFile) {
    let source = '';
    try {
      source = readFileSync(resolve(packageDir, indexFile), 'utf-8');
    } catch {
      return false;
    }
    const reexportLines = (source.match(/export[^;]*from\s+['"]\.[^'"]+['"]/g) ?? []).length;
    // Pure barrel: many `export ... from './...'` and little else.
    if (reexportLines >= 4) return true;
    // No re-exports → looks like a real barrel implementation file, not a re-export hub.
    if (reexportLines === 0) return false;
  }

  return true;
}

function isCodeFile(name: string): boolean {
  return /\.(m?js|c?js|d\.ts|d\.mts|d\.cts|ts|tsx)$/.test(name);
}

export function detectMemberDir(
  packageDir: string,
  layout: StructureConfig['layout'],
): string | undefined {
  if (layout === 'barrel') return undefined;
  if (layout === 'destructure') return '.';
  return KNOWN_MEMBER_DIRS.find((c) => {
    try {
      return statSync(resolve(packageDir, c)).isDirectory();
    } catch {
      return false;
    }
  });
}

export function detectExtensions(
  packageDir: string,
  layout: StructureConfig['layout'],
  memberDir: string | undefined,
): string[] {
  const targetDir =
    layout === 'barrel' || !memberDir || memberDir === '.'
      ? packageDir
      : resolve(packageDir, memberDir);

  let entries: string[] = [];
  try {
    entries = readdirSync(targetDir);
  } catch {
    return [];
  }

  const exts = new Set<string>();
  for (const entry of entries) {
    try {
      const stat = statSync(resolve(targetDir, entry));
      if (stat.isFile()) {
        const ext = entry.endsWith('.d.ts') ? '.d.ts' : extname(entry);
        if (ext) exts.add(ext);
      }
    } catch {
      // ignore
    }
  }

  const allowed = new Set(['.js', '.mjs', '.cjs', '.d.ts', '.d.mts', '.d.cts']);
  return [...exts].filter((e) => allowed.has(e));
}

export function detectNaming(
  packageDir: string,
  layout: StructureConfig['layout'],
  memberDir: string | undefined,
): StructureConfig['naming'] | undefined {
  const samples = sampleFilenames(packageDir, layout, memberDir, 10);
  if (samples.length === 0) return undefined;

  const scores: Record<StructureConfig['naming'], number> = {
    PascalCase: 0,
    camelCase: 0,
    'kebab-case': 0,
    snake_case: 0,
  };

  for (const name of samples) {
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) scores.PascalCase++;
    else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) scores.camelCase++;
    else if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) scores['kebab-case']++;
    else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) scores.snake_case++;
    else if (/^[a-z][a-z0-9]*$/.test(name)) {
      // Single-segment lowercase counts toward both kebab and camel; favor camel.
      scores.camelCase++;
    }
  }

  const sorted = (
    Object.entries(scores) as Array<[StructureConfig['naming'], number]>
  ).sort(([, a], [, b]) => b - a);
  const [best, bestScore] = sorted[0]!;
  if (bestScore === 0) return undefined;
  return best;
}

export function sampleFilenames(
  packageDir: string,
  layout: StructureConfig['layout'],
  memberDir: string | undefined,
  count: number,
): string[] {
  if (layout === 'barrel') return [];
  if (!memberDir) return [];

  const dir = memberDir === '.' ? packageDir : resolve(packageDir, memberDir);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    try {
      const stat = statSync(resolve(dir, entry));
      let base: string;
      if (stat.isDirectory()) {
        base = entry;
      } else if (stat.isFile()) {
        base = stripExtension(entry);
      } else {
        continue;
      }
      if (['index', 'types'].includes(base)) continue;
      names.push(base);
      if (names.length >= count) break;
    } catch {
      // ignore
    }
  }
  return names;
}

function stripExtension(filename: string): string {
  if (filename.endsWith('.d.ts')) return filename.slice(0, -5);
  if (filename.endsWith('.d.mts')) return filename.slice(0, -6);
  if (filename.endsWith('.d.cts')) return filename.slice(0, -6);
  return basename(filename, extname(filename));
}

export function detectNamespace(
  packageDir: string,
  pkgJson: Record<string, unknown>,
): { namespace: string | undefined; exportedMembers: string[] } {
  const entryFile = resolveEntryFile(packageDir, pkgJson);
  if (!entryFile) return { namespace: undefined, exportedMembers: [] };

  let source = '';
  try {
    source = readFileSync(entryFile, 'utf-8');
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

function resolveEntryFile(
  packageDir: string,
  pkgJson: Record<string, unknown>,
): string | null {
  const candidates: string[] = [];
  const main = pkgJson.main as string | undefined;
  const moduleField = pkgJson.module as string | undefined;
  const types = pkgJson.types as string | undefined;
  if (moduleField) candidates.push(moduleField);
  if (main) candidates.push(main);
  if (types) candidates.push(types);
  candidates.push('index.js', 'index.mjs', 'index.cjs', 'index.d.ts');

  for (const c of candidates) {
    const p = resolve(packageDir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

function extractFirstMatch(source: string, regex: RegExp): string | undefined {
  const match = regex.exec(source);
  return match?.[1];
}

function extractExportedNames(source: string): string[] {
  const names = new Set<string>();
  const constRe = /export\s+(?:const|let|var|function|class)\s+([a-zA-Z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = constRe.exec(source)) !== null) {
    names.add(match[1]!);
  }
  const namedRe = /export\s*\{\s*([^}]+)\}/g;
  while ((match = namedRe.exec(source)) !== null) {
    for (const n of match[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!)) {
      if (n) names.add(n);
    }
  }
  return [...names];
}

export function detectMemberShape(
  packageDir: string,
  layout: StructureConfig['layout'],
  memberDir: string | undefined,
  _exportedMembers: string[],
): { methods: string[]; hooks: HookPattern[] } {
  if (layout === 'barrel' || !memberDir) {
    return { methods: [], hooks: [] };
  }

  const sample = pickMemberFile(packageDir, layout, memberDir);
  if (!sample) return { methods: [], hooks: [] };

  let source = '';
  try {
    source = readFileSync(sample, 'utf-8');
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
      argStyle: 'namespace-member',
    });
  }

  return { methods: [...methods], hooks };
}

function pickMemberFile(
  packageDir: string,
  layout: StructureConfig['layout'],
  memberDir: string,
): string | null {
  const dir = resolve(packageDir, memberDir);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    try {
      const full = resolve(dir, entry);
      const stat = statSync(full);
      if (stat.isFile() && (entry.endsWith('.js') || entry.endsWith('.mjs'))) {
        return full;
      }
      if (stat.isDirectory() && layout === 'nested') {
        const nestedEntries = readdirSync(full);
        const candidate = nestedEntries.find(
          (name) => name.endsWith('.js') || name.endsWith('.mjs'),
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
): DetectedConfig['confidence'] {
  const total = Object.values(inputs).length;
  const defined = Object.values(inputs).filter(
    (v) => v !== null && v !== undefined && v !== '',
  ).length;
  if (total === 0) return 'low';
  const ratio = defined / total;
  if (ratio >= 0.9) return 'high';
  if (ratio >= 0.6) return 'medium';
  return 'low';
}
