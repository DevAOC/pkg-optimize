import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type {
  CallExpression,
  Identifier,
  ImportDeclaration,
  MemberExpression,
  Node,
  ObjectExpression,
  ObjectProperty,
  TemplateLiteral,
} from '@babel/types';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { isAbortError, isDirectory, pathExists, withSignal } from './utils.js';
import type { PatternsConfig, UsageMap } from './types.js';

// `@babel/traverse` is a CJS module; default-export interop differs between
// ESM and CJS bundles. Normalize here.
const traverse: typeof _traverse =
  (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  '.pkg-optimize-cache',
]);

export interface ScanOptions {
  /**
   * The exact package name as it appears in `import ... from '...'`
   * statements. Used to attribute imports to the target package and to detect
   * deep-import file references.
   */
  targetPackage?: string;
  /** When aborted, directory walks and file reads stop cooperatively. */
  signal?: AbortSignal;
}

export async function scanDirs(
  dirs: string[],
  projectRoot: string,
  patterns: PatternsConfig,
  options: ScanOptions = {},
): Promise<UsageMap> {
  options.signal?.throwIfAborted();
  const usageMap: UsageMap = {
    members: new Set(),
    operations: new Set(),
    files: new Set(),
  };

  const { signal } = options;
  await Promise.all(
    dirs.map(async (dir) => {
      const abs = resolve(projectRoot, dir);
      if (!(await pathExists(abs, signal))) return;
      await walkDir(
        abs,
        (filePath) => scanFile(filePath, patterns, usageMap, options),
        signal,
      );
    }),
  );

  return usageMap;
}

export async function scanFile(
  filePath: string,
  patterns: PatternsConfig,
  usageMap: UsageMap,
  options: ScanOptions = {},
): Promise<void> {
  const { signal } = options;
  let source: string;
  try {
    source = await withSignal(signal, () => readFile(filePath, { encoding: 'utf-8' }));
  } catch (err) {
    if (isAbortError(err)) throw err;
    return;
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['typescript', 'jsx', 'decorators-legacy'],
    });
  } catch {
    return;
  }

  // Pass 1 — collect imports from the target package. We need this to run
  // before member-access scanning so that any local name bound to the target
  // (default or namespace import) is treated as a namespace for member access.
  const dynamicNamespaces = new Set<string>();
  if (patterns.namespace) dynamicNamespaces.add(patterns.namespace);

  if (options.targetPackage) {
    traverse(ast, {
      ImportDeclaration(path: NodePath<ImportDeclaration>) {
        handleImport(path.node, options.targetPackage!, usageMap, dynamicNamespaces);
      },
    });
  }

  // Pass 2 — member access + hook call sites.
  const hooksByName = new Map<string, typeof patterns.hooks>();
  for (const h of patterns.hooks ?? []) {
    const list = hooksByName.get(h.name);
    if (list) list.push(h);
    else hooksByName.set(h.name, [h]);
  }

  traverse(ast, {
    MemberExpression(path: NodePath<MemberExpression>) {
      // The `dynamicNamespaces` set acts as the gate — it includes the
      // configured static namespace and any local names bound to the target
      // package via default or namespace imports. `accessStyle` is now
      // informational only.
      const node = path.node;
      const { object, property, computed } = node;

      if (computed) return;
      if (object.type !== 'Identifier' || property.type !== 'Identifier') return;
      if (dynamicNamespaces.size === 0) return;
      if (!dynamicNamespaces.has((object as Identifier).name)) return;

      const memberName = (property as Identifier).name;
      usageMap.members.add(memberName);

      const parent = path.parent as Node | null;
      if (
        parent &&
        parent.type === 'MemberExpression' &&
        parent.object === node &&
        !parent.computed &&
        parent.property.type === 'Identifier'
      ) {
        usageMap.operations.add(`${memberName}.${parent.property.name}`);
      }
    },

    CallExpression(path: NodePath<CallExpression>) {
      const node = path.node;

      if (options.targetPackage) {
        handleDynamicReference(node, options.targetPackage, usageMap);
      }

      const { callee, arguments: args } = node;
      if (callee.type !== 'Identifier') return;
      const hooks = hooksByName.get(callee.name);
      if (!hooks) return;

      for (const hook of hooks) {
        const arg = args[hook.argIndex];
        if (!arg) continue;
        applyHookPattern(arg, hook, dynamicNamespaces, usageMap);
      }
    },
  });
}

/**
 * Detect `import('pkg/...')`, `require('pkg/...')`, and `require.resolve('pkg/...')`
 * call sites and route them through the same allow-list logic as static imports.
 *
 * When the argument is a non-static expression (a runtime variable, a
 * concatenation, etc.) we set `usageMap.wildcard = true` so the pruner falls
 * back to restore-only mode rather than risk deleting a file the dynamic call
 * needs at runtime.
 */
function handleDynamicReference(
  node: CallExpression,
  targetPackage: string,
  usageMap: UsageMap,
): void {
  const arg = getDynamicReferenceArg(node);
  if (!arg) return;

  if (arg.type === 'StringLiteral') {
    const subpath = matchPackageSubpath(arg.value, targetPackage);
    if (subpath === null) return; // not our package
    if (subpath === '') {
      // `import('pkg')` with no subpath — the call returns the whole namespace
      // object and we have no way to know which exports are actually consumed.
      usageMap.wildcard = true;
    } else {
      usageMap.files.add(stripFilenameExt(subpath));
    }
    return;
  }

  if (arg.type === 'TemplateLiteral') {
    const tpl = arg as TemplateLiteral;
    const firstQuasi = tpl.quasis[0];
    if (!firstQuasi) return;
    const prefix = firstQuasi.value.cooked ?? firstQuasi.value.raw ?? '';
    const trimmed = prefix.replace(/\/+$/, '');

    if (trimmed === targetPackage) {
      // `import(\`pkg/${x}\`)` — could be any subpath of the target.
      usageMap.wildcard = true;
      return;
    }
    const subpath = matchPackageSubpath(trimmed, targetPackage);
    if (subpath === null) return; // prefix doesn't reach our package, ignore
    // `import(\`pkg/sub/${x}\`)` — record `sub` so the whole `sub/` tree is kept.
    usageMap.files.add(stripFilenameExt(subpath));
    return;
  }

  // Anything else (Identifier, BinaryExpression, etc.) is impossible to
  // statically resolve. We can't tell whether it points at our target
  // package, so we don't trigger wildcard here — that would defeat all
  // pruning the moment a user wrote `import(somePath)` for an unrelated
  // package. The `import 'pkg/...'` and `require('pkg/...')` paths above
  // already cover the common safe cases.
}

function getDynamicReferenceArg(node: CallExpression): Node | null {
  const callee = node.callee as Node;

  // `import('foo')`
  if (callee.type === 'Import') {
    return (node.arguments[0] as Node | undefined) ?? null;
  }

  // `require('foo')`
  if (
    callee.type === 'Identifier' &&
    (callee as Identifier).name === 'require'
  ) {
    return (node.arguments[0] as Node | undefined) ?? null;
  }

  // `require.resolve('foo')`
  if (
    callee.type === 'MemberExpression' &&
    !(callee as MemberExpression).computed &&
    (callee as MemberExpression).object.type === 'Identifier' &&
    ((callee as MemberExpression).object as Identifier).name === 'require' &&
    (callee as MemberExpression).property.type === 'Identifier' &&
    ((callee as MemberExpression).property as Identifier).name === 'resolve'
  ) {
    return (node.arguments[0] as Node | undefined) ?? null;
  }

  return null;
}

function handleImport(
  node: ImportDeclaration,
  targetPackage: string,
  usageMap: UsageMap,
  dynamicNamespaces: Set<string>,
): void {
  const source = node.source.value;
  const subpath = matchPackageSubpath(source, targetPackage);
  if (subpath === null) return;

  const isDeepImport = subpath.length > 0;

  // Side-effect import: `import 'pkg'` or `import 'pkg/sub'`.
  if (node.specifiers.length === 0) {
    if (isDeepImport) usageMap.files.add(stripFilenameExt(subpath));
    return;
  }

  for (const spec of node.specifiers) {
    if (spec.type === 'ImportSpecifier') {
      if (isDeepImport) {
        // Deep imports go straight to the file allow-list; we don't try to
        // drill into the named exports of an inner module (they may be barrel
        // re-exports we can't reliably trace).
        usageMap.files.add(stripFilenameExt(subpath));
      } else {
        const importedName =
          spec.imported.type === 'Identifier'
            ? spec.imported.name
            : spec.imported.value;
        usageMap.members.add(importedName);
      }
    } else if (
      spec.type === 'ImportDefaultSpecifier' ||
      spec.type === 'ImportNamespaceSpecifier'
    ) {
      if (isDeepImport) {
        usageMap.files.add(stripFilenameExt(subpath));
      } else {
        // `import _ from 'pkg'` or `import * as _ from 'pkg'`: bind `_` as a
        // namespace so subsequent `_.foo` access is recorded as a member.
        dynamicNamespaces.add(spec.local.name);
      }
    }
  }
}

/**
 * If `source` references the target package, return the subpath after the
 * package name (`""` for a top-level import). Returns `null` otherwise.
 */
function matchPackageSubpath(source: string, targetPackage: string): string | null {
  if (source === targetPackage) return '';
  const prefix = targetPackage + '/';
  if (source.startsWith(prefix)) return source.slice(prefix.length);
  return null;
}

function stripFilenameExt(p: string): string {
  if (p.endsWith('.d.ts')) return p.slice(0, -5);
  if (p.endsWith('.d.mts')) return p.slice(0, -6);
  if (p.endsWith('.d.cts')) return p.slice(0, -6);
  const lastSlash = p.lastIndexOf('/');
  const lastDot = p.lastIndexOf('.');
  if (lastDot <= lastSlash) return p;
  if (lastDot <= 0) return p;
  return p.slice(0, lastDot);
}

function applyHookPattern(
  arg: Node,
  hook: NonNullable<PatternsConfig['hooks']>[number],
  namespaces: Set<string>,
  usageMap: UsageMap,
): void {
  switch (hook.argStyle) {
    case 'namespace-member': {
      if (
        arg.type === 'MemberExpression' &&
        !arg.computed &&
        arg.object.type === 'Identifier' &&
        namespaces.has((arg.object as Identifier).name) &&
        arg.property.type === 'Identifier'
      ) {
        usageMap.members.add((arg.property as Identifier).name);
      }
      break;
    }
    case 'namespace-member-member': {
      if (
        arg.type === 'MemberExpression' &&
        !arg.computed &&
        arg.object.type === 'MemberExpression' &&
        !arg.object.computed &&
        arg.object.object.type === 'Identifier' &&
        namespaces.has((arg.object.object as Identifier).name) &&
        arg.object.property.type === 'Identifier' &&
        arg.property.type === 'Identifier'
      ) {
        const member = (arg.object.property as Identifier).name;
        const operation = (arg.property as Identifier).name;
        usageMap.members.add(member);
        usageMap.operations.add(`${member}.${operation}`);
      }
      break;
    }
    case 'string': {
      if (arg.type === 'StringLiteral') {
        usageMap.members.add(arg.value);
      }
      break;
    }
    case 'imported-identifier': {
      if (arg.type === 'Identifier') {
        usageMap.members.add(arg.name);
      }
      break;
    }
    case 'object-property-identifier': {
      const value = readObjectProperty(arg, hook.objectProperty);
      if (value && value.type === 'Identifier') {
        usageMap.members.add(value.name);
      }
      break;
    }
    case 'object-property-string': {
      const value = readObjectProperty(arg, hook.objectProperty);
      if (value && value.type === 'StringLiteral') {
        usageMap.members.add(value.value);
      }
      break;
    }
  }
}

function readObjectProperty(
  arg: Node,
  propertyName: string | undefined,
): Node | null {
  if (!propertyName) return null;
  if (arg.type !== 'ObjectExpression') return null;
  const obj = arg as ObjectExpression;
  for (const prop of obj.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    const op = prop as ObjectProperty;
    if (op.computed) continue;
    if (
      (op.key.type === 'Identifier' && (op.key as Identifier).name === propertyName) ||
      (op.key.type === 'StringLiteral' && op.key.value === propertyName)
    ) {
      return op.value as Node;
    }
  }
  return null;
}

async function walkDir(
  dir: string,
  cb: (filePath: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let entries: Dirent[];
  try {
    entries = (await withSignal(signal, () =>
      readdir(dir, { withFileTypes: true }),
    )) as Dirent[];
  } catch (err) {
    if (isAbortError(err)) throw err;
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (entry.isDirectory()) return;
      }
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) return;
        await walkDir(full, cb, signal);
      } else if (entry.isFile()) {
        const ext = entry.name.endsWith('.d.ts') ? '.d.ts' : extname(entry.name);
        if (SCAN_EXTENSIONS.has(ext)) await cb(full);
      }
    }),
  );
}

export function dirExists(path: string): Promise<boolean> {
  return isDirectory(path);
}
