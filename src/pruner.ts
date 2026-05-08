import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type {
  PruneResult,
  ResolvedPackageConfig,
  StructureConfig,
  UsageMap,
} from './types.js';

export interface PruneArgs {
  usageMap: UsageMap;
  config: ResolvedPackageConfig;
  /** The pristine cached copy. */
  sourceDir: string;
  /** The live `node_modules` copy that gets mutated. */
  targetDir: string;
  /** When true, do not delete from disk — only warn. Restores still happen. */
  soft?: boolean;
}

interface AllowSet {
  members: Set<string>;
  operations: Set<string>;
  /** Paths (without extension, slash-separated, relative to package root). */
  files: Set<string>;
}

export function prune(args: PruneArgs): PruneResult {
  const { usageMap, config, sourceDir } = args;
  const allowSet = buildAllowSet(usageMap, config.allow);

  const result: PruneResult = {
    packageName: config.targetPackage,
    removed: [],
    restored: [],
    kept: [],
    warnings: [],
  };

  if (!existsSync(sourceDir)) {
    result.warnings.push(
      `No cache found at ${sourceDir}. Skipping prune for ${config.targetPackage}.`,
    );
    return result;
  }

  // Dynamic-import escape hatch: when the scanner saw an `import('pkg')` /
  // `require('pkg')` / `import(somePath)` it couldn't statically resolve, we
  // can't safely remove anything. Restore everything and bail.
  if (usageMap.wildcard) {
    restoreAll(args, result);
    result.warnings.push(
      `${config.targetPackage}: dynamic import detected with an unresolvable target — pruning skipped, all files kept/restored.`,
    );
    return result;
  }

  const layout = config.packageStructure.layout;

  switch (layout) {
    case 'nested':
      pruneNested(args, allowSet, result);
      break;
    case 'flat':
      pruneFlat(args, allowSet, result);
      break;
    case 'destructure':
      pruneDestructure(args, allowSet, result);
      break;
    case 'barrel':
      result.warnings.push(
        `${config.targetPackage} uses a "barrel" layout — file-level pruning is not supported. ` +
          `Consider asking the package author to provide individual entry points, or use deep imports ` +
          `(e.g. \`import x from '${config.targetPackage}/path/to/x'\`) and switch the layout to "destructure".`,
      );
      break;
  }

  return result;
}

function buildAllowSet(
  usageMap: UsageMap,
  allow: { include?: string[] } | undefined,
): AllowSet {
  const members = new Set<string>();
  const operations = new Set<string>();
  const files = new Set<string>();

  for (const m of usageMap.members ?? []) members.add(toCamelCase(m));
  for (const o of usageMap.operations ?? []) {
    const [member, operation] = o.split('.');
    if (!member || !operation) continue;
    members.add(toCamelCase(member));
    operations.add(`${toCamelCase(member)}.${toCamelCase(operation)}`);
  }
  for (const f of usageMap.files ?? []) {
    files.add(normalizeFileRef(f));
  }

  for (const sym of allow?.include ?? []) {
    // `allow.include` accepts members, `member.operation`, and explicit
    // `path/to/file` references (anything containing a slash is treated as a
    // file reference rather than a symbol).
    if (sym.includes('/')) {
      files.add(normalizeFileRef(sym));
    } else if (sym.includes('.')) {
      const [member, operation] = sym.split('.');
      if (!member || !operation) continue;
      members.add(toCamelCase(member));
      operations.add(`${toCamelCase(member)}.${toCamelCase(operation)}`);
    } else {
      members.add(toCamelCase(sym));
    }
  }

  for (const o of operations) {
    const [member] = o.split('.');
    if (member) members.add(member);
  }

  return { members, operations, files };
}

function normalizeFileRef(p: string): string {
  return p.replace(/^\.?\/+/, '').replace(/\/+$/, '').replace(/\\/g, '/');
}

/**
 * Returns true if `relPath` (without extension, slash-separated) matches any
 * entry in `files`, or is a parent or child of one. Used to keep deep-imported
 * files alive even when they don't match a known member.
 */
function pathMatchesFiles(relPath: string, files: Set<string>): boolean {
  if (files.size === 0) return false;
  const normalized = normalizeFileRef(relPath);
  if (files.has(normalized)) return true;
  for (const entry of files) {
    if (entry === normalized) return true;
    if (normalized.startsWith(entry + '/')) return true; // entry is an ancestor of relPath
    if (entry.startsWith(normalized + '/')) return true; // relPath is an ancestor of entry
  }
  return false;
}

function pruneNested(args: PruneArgs, allowSet: AllowSet, result: PruneResult): void {
  const { config, sourceDir, targetDir, soft } = args;
  const memberDirName = config.packageStructure.memberDir ?? 'members';
  const cachedMembersDir = resolve(sourceDir, memberDirName);
  const liveMembersDir = resolve(targetDir, memberDirName);

  if (!existsSync(cachedMembersDir)) {
    result.warnings.push(
      `Cached member dir ${memberDirName} not found in cache for ${config.targetPackage}.`,
    );
    return;
  }

  const memberEntries = safeReaddir(cachedMembersDir);

  for (const entry of memberEntries) {
    const cachedEntryPath = resolve(cachedMembersDir, entry);
    const liveEntryPath = resolve(liveMembersDir, entry);
    let isDir = false;
    try {
      isDir = statSync(cachedEntryPath).isDirectory();
    } catch {
      continue;
    }

    if (!isDir) {
      if (isPreserved(entry, config.packageStructure)) {
        ensureFileFromCache(cachedEntryPath, liveEntryPath, result, entry);
      }
      continue;
    }

    const memberSymbol = toCamelCase(entry);
    const memberAllowed =
      allowSet.members.has(memberSymbol) ||
      pathMatchesFiles(`${memberDirName}/${entry}`, allowSet.files);

    if (!memberAllowed) {
      removeIfPresent(liveEntryPath, soft, result, `${memberDirName}/${entry}`);
      continue;
    }

    if (!existsSync(liveEntryPath)) {
      mkdirSync(liveEntryPath, { recursive: true });
    }

    walkFiles(cachedEntryPath, (cachedFilePath) => {
      const relFromMember = relative(cachedEntryPath, cachedFilePath);
      const liveFilePath = resolve(liveEntryPath, relFromMember);
      const segments = relFromMember.split(/[\\/]+/);
      const isOperationFile = segments.length > 1;
      const fullRel = `${memberDirName}/${entry}/${relFromMember}`;

      if (!isOperationFile) {
        ensureFileFromCache(cachedFilePath, liveFilePath, result, fullRel);
        return;
      }

      const operationFile = segments[segments.length - 1]!;
      if (isPreserved(operationFile, config.packageStructure)) {
        ensureFileFromCache(cachedFilePath, liveFilePath, result, fullRel);
        return;
      }

      const operationSymbol = toCamelCase(
        stripExtension(operationFile, config.packageStructure.extensions),
      );
      const operationAllowed =
        allowSet.operations.has(`${memberSymbol}.${operationSymbol}`) ||
        pathMatchesFiles(fullRel, allowSet.files);

      if (operationAllowed) {
        ensureFileFromCache(cachedFilePath, liveFilePath, result, fullRel);
      } else {
        removeIfPresent(liveFilePath, soft, result, fullRel);
      }
    });
  }

  preserveTopLevel(args, result);
}

function pruneFlat(args: PruneArgs, allowSet: AllowSet, result: PruneResult): void {
  const { config } = args;
  const memberDirName = config.packageStructure.memberDir;
  const operationDirName = config.packageStructure.operationDir;

  if (memberDirName) {
    processFlatDir(
      resolve(args.sourceDir, memberDirName),
      resolve(args.targetDir, memberDirName),
      memberDirName,
      'member',
      args,
      allowSet,
      result,
    );
  }

  if (operationDirName && operationDirName !== memberDirName) {
    processFlatDir(
      resolve(args.sourceDir, operationDirName),
      resolve(args.targetDir, operationDirName),
      operationDirName,
      'operation',
      args,
      allowSet,
      result,
    );
  }

  preserveTopLevel(args, result);
}

function processFlatDir(
  cachedDir: string,
  liveDir: string,
  dirName: string,
  kind: 'member' | 'operation',
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult,
): void {
  const { config, soft } = args;
  if (!existsSync(cachedDir)) {
    result.warnings.push(`Cached dir ${dirName} not found for ${config.targetPackage}.`);
    return;
  }

  const entries = safeReaddir(cachedDir);

  for (const entry of entries) {
    const cachedFile = resolve(cachedDir, entry);
    const liveFile = resolve(liveDir, entry);
    let isDir = false;
    try {
      isDir = statSync(cachedFile).isDirectory();
    } catch {
      continue;
    }

    if (isDir) continue;

    const fullRel = `${dirName}/${entry}`;

    if (isPreserved(entry, config.packageStructure)) {
      ensureFileFromCache(cachedFile, liveFile, result, fullRel);
      continue;
    }

    const stripped = stripExtension(entry, config.packageStructure.extensions);
    let allowed = false;
    if (kind === 'member') {
      const memberSymbol = toCamelCase(stripped);
      allowed = allowSet.members.has(memberSymbol);
    } else {
      const symbol = toCamelCase(stripped.replace(/[._-]/g, '.'));
      allowed = allowSet.operations.has(symbol);
      if (!allowed) {
        const justMember = toCamelCase(stripped);
        allowed = allowSet.members.has(justMember);
      }
    }
    if (!allowed) allowed = pathMatchesFiles(fullRel, allowSet.files);

    if (allowed) {
      ensureFileFromCache(cachedFile, liveFile, result, fullRel);
    } else {
      removeIfPresent(liveFile, soft, result, fullRel);
    }
  }
}

/**
 * Layout for packages whose top-level entries are themselves the units of
 * pruning — `lodash-es`, `date-fns`, `react-icons/fa`, `@radix-ui/react-icons`,
 * etc. Each direct child of `memberDir` (defaulting to the package root) is
 * either a single file or a directory; we keep or remove it as a whole based
 * on whether its symbol or path is in the allow set.
 */
function pruneDestructure(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult,
): void {
  const { config, sourceDir, targetDir, soft } = args;
  const memberDirName = config.packageStructure.memberDir ?? '.';
  const cachedRoot = resolve(sourceDir, memberDirName);
  const liveRoot = resolve(targetDir, memberDirName);

  if (!existsSync(cachedRoot)) {
    result.warnings.push(
      `Cached member dir ${memberDirName} not found in cache for ${config.targetPackage}.`,
    );
    return;
  }

  const entries = safeReaddir(cachedRoot);
  const dirPrefix = memberDirName === '.' || memberDirName === '' ? '' : `${memberDirName}/`;

  for (const entry of entries) {
    const cachedEntry = resolve(cachedRoot, entry);
    const liveEntry = resolve(liveRoot, entry);
    let stat;
    try {
      stat = statSync(cachedEntry);
    } catch {
      continue;
    }

    const fullRel = `${dirPrefix}${entry}`;

    if (isPreserved(entry, config.packageStructure)) {
      ensureFileFromCache(cachedEntry, liveEntry, result, fullRel);
      continue;
    }

    const stripped = stripExtension(entry, config.packageStructure.extensions);
    const memberSymbol = toCamelCase(stripped);
    const allowed =
      allowSet.members.has(memberSymbol) ||
      pathMatchesFiles(fullRel, allowSet.files) ||
      pathMatchesFiles(`${dirPrefix}${stripped}`, allowSet.files);

    if (allowed) {
      ensureFileFromCache(cachedEntry, liveEntry, result, fullRel);
    } else if (stat.isDirectory()) {
      removeIfPresent(liveEntry, soft, result, fullRel);
    } else {
      removeIfPresent(liveEntry, soft, result, fullRel);
    }
  }

  if (memberDirName !== '.' && memberDirName !== '') {
    preserveTopLevel(args, result);
  }
}

/**
 * Walk the cached package and ensure every file exists in live. Used in
 * dynamic-import wildcard mode: we can't safely remove anything, but we still
 * want to *restore* anything that may have been pruned in a prior run.
 */
function restoreAll(args: PruneArgs, result: PruneResult): void {
  const { sourceDir, targetDir } = args;
  walkFiles(sourceDir, (cachedPath) => {
    const rel = relative(sourceDir, cachedPath).split(sep).join('/');
    const livePath = resolve(targetDir, rel);
    ensureFileFromCache(cachedPath, livePath, result, rel);
  });
}

function preserveTopLevel(args: PruneArgs, result: PruneResult): void {
  const { config, sourceDir, targetDir } = args;
  const entries = safeReaddir(sourceDir);
  for (const entry of entries) {
    const cached = resolve(sourceDir, entry);
    const live = resolve(targetDir, entry);
    let isFile = false;
    try {
      isFile = statSync(cached).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    if (isPreserved(entry, config.packageStructure)) {
      ensureFileFromCache(cached, live, result, entry);
    }
  }
}

function ensureFileFromCache(
  cachedPath: string,
  livePath: string,
  result: PruneResult,
  label: string,
): void {
  if (!existsSync(cachedPath)) return;
  if (!existsSync(livePath)) {
    mkdirSync(dirname(livePath), { recursive: true });
    cpSync(cachedPath, livePath, { recursive: true, force: true });
    result.restored.push(label);
  } else {
    result.kept.push(label);
  }
}

function removeIfPresent(
  livePath: string,
  soft: boolean | undefined,
  result: PruneResult,
  label: string,
): void {
  if (!existsSync(livePath)) return;
  if (soft) {
    result.warnings.push(`Would remove ${label} (soft mode)`);
    return;
  }
  rmSync(livePath, { recursive: true, force: true });
  result.removed.push(label);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function walkFiles(dir: string, cb: (filePath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkFiles(full, cb);
    else if (stat.isFile()) cb(full);
  }
}

export function isPreserved(filename: string, structure: StructureConfig): boolean {
  return structure.preserve.includes(filename);
}

export function stripExtension(
  filename: string,
  knownExtensions?: string[],
): string {
  if (knownExtensions && knownExtensions.length > 0) {
    const sorted = [...knownExtensions].sort((a, b) => b.length - a.length);
    for (const ext of sorted) {
      if (ext.length > 0 && filename.endsWith(ext)) {
        return filename.slice(0, -ext.length);
      }
    }
  }
  if (filename.endsWith('.d.ts')) return filename.slice(0, -5);
  if (filename.endsWith('.d.mts')) return filename.slice(0, -6);
  if (filename.endsWith('.d.cts')) return filename.slice(0, -6);
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return filename;
  return filename.slice(0, dot);
}

export function toCamelCase(name: string): string {
  if (!name) return name;
  const parts = name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return name;
  const [first, ...rest] = parts;
  return (
    first!.toLowerCase() +
    rest
      .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
      .join('')
  );
}

export function symbolToFilename(
  symbol: string,
  naming: StructureConfig['naming'],
): string {
  switch (naming) {
    case 'PascalCase':
      return symbol[0]!.toUpperCase() + symbol.slice(1);
    case 'camelCase':
      return symbol[0]!.toLowerCase() + symbol.slice(1);
    case 'kebab-case':
      return symbol.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    case 'snake_case':
      return symbol.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  }
}
