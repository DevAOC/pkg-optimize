import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { isAbortError, pathExists, withSignal } from './utils.js';
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
  /** Aborted scans/prunes stop cooperatively (watch shutdown, SIGINT, etc.). */
  signal?: AbortSignal;
}

interface AllowSet {
  members: Set<string>;
  operations: Set<string>;
  /** Paths (without extension, slash-separated, relative to package root). */
  files: Set<string>;
}

export async function prune(args: PruneArgs): Promise<PruneResult> {
  const { usageMap, config, sourceDir, signal } = args;
  signal?.throwIfAborted();
  const allowSet = buildAllowSet(usageMap, config.allow);

  const result: PruneResult = {
    packageName: config.targetPackage,
    removed: [],
    restored: [],
    kept: [],
    warnings: [],
  };

  if (!(await pathExists(sourceDir, signal))) {
    result.warnings.push(
      `No cache found at ${sourceDir}. Skipping prune for ${config.targetPackage}.`,
    );
    return result;
  }

  // Dynamic-import escape hatch: when the scanner saw an `import('pkg')` /
  // `require('pkg')` / `import(somePath)` it couldn't statically resolve, we
  // can't safely remove anything. Restore everything and bail.
  if (usageMap.wildcard) {
    await restoreAll(args, result);
    result.warnings.push(
      `${config.targetPackage}: dynamic import detected with an unresolvable target — pruning skipped, all files kept/restored.`,
    );
    return result;
  }

  const layout = config.packageStructure.layout;

  switch (layout) {
    case 'nested':
      await pruneNested(args, allowSet, result);
      break;
    case 'flat':
      await pruneFlat(args, allowSet, result);
      break;
    case 'destructure':
      await pruneDestructure(args, allowSet, result);
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

async function pruneNested(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult,
): Promise<void> {
  const { config, sourceDir, targetDir, soft, signal } = args;
  const memberDirName = config.packageStructure.memberDir ?? 'members';
  const cachedMembersDir = resolve(sourceDir, memberDirName);
  const liveMembersDir = resolve(targetDir, memberDirName);

  if (!(await pathExists(cachedMembersDir, signal))) {
    result.warnings.push(
      `Cached member dir ${memberDirName} not found in cache for ${config.targetPackage}.`,
    );
    return;
  }

  const memberEntries = await safeReaddir(cachedMembersDir, signal);

  await Promise.all(
    memberEntries.map(async (entry) => {
      signal?.throwIfAborted();
      const cachedEntryPath = resolve(cachedMembersDir, entry);
      const liveEntryPath = resolve(liveMembersDir, entry);
      let isDir = false;
      try {
        isDir = (await withSignal(signal, () => stat(cachedEntryPath))).isDirectory();
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }

      if (!isDir) {
        if (isPreserved(entry, config.packageStructure)) {
          await ensureFileFromCache(cachedEntryPath, liveEntryPath, result, entry, signal);
        }
        return;
      }

      const memberSymbol = toCamelCase(entry);
      const memberAllowed =
        allowSet.members.has(memberSymbol) ||
        pathMatchesFiles(`${memberDirName}/${entry}`, allowSet.files);

      if (!memberAllowed) {
        await removeIfPresent(liveEntryPath, soft, result, `${memberDirName}/${entry}`, signal);
        return;
      }

      if (!(await pathExists(liveEntryPath, signal))) {
        await withSignal(signal, () => mkdir(liveEntryPath, { recursive: true }));
      }

      await walkFiles(cachedEntryPath, async (cachedFilePath) => {
        const relFromMember = relative(cachedEntryPath, cachedFilePath);
        const liveFilePath = resolve(liveEntryPath, relFromMember);
        const segments = relFromMember.split(/[\\/]+/);
        const isOperationFile = segments.length > 1;
        const fullRel = `${memberDirName}/${entry}/${relFromMember}`;

        if (!isOperationFile) {
          await ensureFileFromCache(cachedFilePath, liveFilePath, result, fullRel, signal);
          return;
        }

        const operationFile = segments[segments.length - 1]!;
        if (isPreserved(operationFile, config.packageStructure)) {
          await ensureFileFromCache(cachedFilePath, liveFilePath, result, fullRel, signal);
          return;
        }

        const operationSymbol = toCamelCase(
          stripExtension(operationFile, config.packageStructure.extensions),
        );
        const operationAllowed =
          allowSet.operations.has(`${memberSymbol}.${operationSymbol}`) ||
          pathMatchesFiles(fullRel, allowSet.files);

        if (operationAllowed) {
          await ensureFileFromCache(cachedFilePath, liveFilePath, result, fullRel, signal);
        } else {
          await removeIfPresent(liveFilePath, soft, result, fullRel, signal);
        }
      }, signal);
    }),
  );

  await preserveTopLevel(args, result);
}

async function pruneFlat(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult,
): Promise<void> {
  const { config, signal } = args;
  const memberDirName = config.packageStructure.memberDir;
  const operationDirName = config.packageStructure.operationDir;

  const jobs: Array<Promise<void>> = [];

  if (memberDirName) {
    jobs.push(
      processFlatDir(
        resolve(args.sourceDir, memberDirName),
        resolve(args.targetDir, memberDirName),
        memberDirName,
        'member',
        args,
        allowSet,
        result,
      ),
    );
  }

  if (operationDirName && operationDirName !== memberDirName) {
    jobs.push(
      processFlatDir(
        resolve(args.sourceDir, operationDirName),
        resolve(args.targetDir, operationDirName),
        operationDirName,
        'operation',
        args,
        allowSet,
        result,
      ),
    );
  }

  await Promise.all(jobs);
  await preserveTopLevel(args, result);
}

async function processFlatDir(
  cachedDir: string,
  liveDir: string,
  dirName: string,
  kind: 'member' | 'operation',
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult,
): Promise<void> {
  const { config, soft, signal } = args;
  if (!(await pathExists(cachedDir, signal))) {
    result.warnings.push(`Cached dir ${dirName} not found for ${config.targetPackage}.`);
    return;
  }

  const entries = await safeReaddir(cachedDir, signal);

  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const cachedFile = resolve(cachedDir, entry);
      const liveFile = resolve(liveDir, entry);
      let isDir = false;
      try {
        isDir = (await withSignal(signal, () => stat(cachedFile))).isDirectory();
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }

      if (isDir) return;

      const fullRel = `${dirName}/${entry}`;

      if (isPreserved(entry, config.packageStructure)) {
        await ensureFileFromCache(cachedFile, liveFile, result, fullRel, signal);
        return;
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
        await ensureFileFromCache(cachedFile, liveFile, result, fullRel, signal);
      } else {
        await removeIfPresent(liveFile, soft, result, fullRel, signal);
      }
    }),
  );
}

/**
 * Layout for packages whose top-level entries are themselves the units of
 * pruning — `lodash-es`, `date-fns`, `react-icons/fa`, `@radix-ui/react-icons`,
 * etc. Each direct child of `memberDir` (defaulting to the package root) is
 * either a single file or a directory; we keep or remove it as a whole based
 * on whether its symbol or path is in the allow set.
 */
async function pruneDestructure(
  args: PruneArgs,
  allowSet: AllowSet,
  result: PruneResult,
): Promise<void> {
  const { config, sourceDir, targetDir, soft, signal } = args;
  const memberDirName = config.packageStructure.memberDir ?? '.';
  const cachedRoot = resolve(sourceDir, memberDirName);
  const liveRoot = resolve(targetDir, memberDirName);

  if (!(await pathExists(cachedRoot, signal))) {
    result.warnings.push(
      `Cached member dir ${memberDirName} not found in cache for ${config.targetPackage}.`,
    );
    return;
  }

  const entries = await safeReaddir(cachedRoot, signal);
  const dirPrefix = memberDirName === '.' || memberDirName === '' ? '' : `${memberDirName}/`;

  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const cachedEntry = resolve(cachedRoot, entry);
      const liveEntry = resolve(liveRoot, entry);
      let s;
      try {
        s = await withSignal(signal, () => stat(cachedEntry));
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }

      const fullRel = `${dirPrefix}${entry}`;

      if (isPreserved(entry, config.packageStructure)) {
        await ensureFileFromCache(cachedEntry, liveEntry, result, fullRel, signal);
        return;
      }

      const stripped = stripExtension(entry, config.packageStructure.extensions);
      const memberSymbol = toCamelCase(stripped);
      const allowed =
        allowSet.members.has(memberSymbol) ||
        pathMatchesFiles(fullRel, allowSet.files) ||
        pathMatchesFiles(`${dirPrefix}${stripped}`, allowSet.files);

      if (allowed) {
        await ensureFileFromCache(cachedEntry, liveEntry, result, fullRel, signal);
      } else if (s.isDirectory()) {
        await removeIfPresent(liveEntry, soft, result, fullRel, signal);
      } else {
        await removeIfPresent(liveEntry, soft, result, fullRel, signal);
      }
    }),
  );

  if (memberDirName !== '.' && memberDirName !== '') {
    await preserveTopLevel(args, result);
  }
}

/**
 * Walk the cached package and ensure every file exists in live. Used in
 * dynamic-import wildcard mode: we can't safely remove anything, but we still
 * want to *restore* anything that may have been pruned in a prior run.
 */
async function restoreAll(args: PruneArgs, result: PruneResult): Promise<void> {
  const { sourceDir, targetDir, signal } = args;
  await walkFiles(
    sourceDir,
    async (cachedPath) => {
      const rel = relative(sourceDir, cachedPath).split(sep).join('/');
      const livePath = resolve(targetDir, rel);
      await ensureFileFromCache(cachedPath, livePath, result, rel, signal);
    },
    signal,
  );
}

async function preserveTopLevel(args: PruneArgs, result: PruneResult): Promise<void> {
  const { config, sourceDir, targetDir, signal } = args;
  const entries = await safeReaddir(sourceDir, signal);
  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const cached = resolve(sourceDir, entry);
      const live = resolve(targetDir, entry);
      let isFile = false;
      try {
        isFile = (await withSignal(signal, () => stat(cached))).isFile();
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }
      if (!isFile) return;
      if (isPreserved(entry, config.packageStructure)) {
        await ensureFileFromCache(cached, live, result, entry, signal);
      }
    }),
  );
}

async function ensureFileFromCache(
  cachedPath: string,
  livePath: string,
  result: PruneResult,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!(await pathExists(cachedPath, signal))) return;
  if (!(await pathExists(livePath, signal))) {
    await withSignal(signal, () => mkdir(dirname(livePath), { recursive: true }));
    await withSignal(signal, () =>
      cp(cachedPath, livePath, { recursive: true, force: true }),
    );
    result.restored.push(label);
  } else {
    result.kept.push(label);
  }
}

async function removeIfPresent(
  livePath: string,
  soft: boolean | undefined,
  result: PruneResult,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!(await pathExists(livePath, signal))) return;
  if (soft) {
    result.warnings.push(`Would remove ${label} (soft mode)`);
    return;
  }
  await withSignal(signal, () => rm(livePath, { recursive: true, force: true }));
  result.removed.push(label);
}

async function safeReaddir(dir: string, signal?: AbortSignal): Promise<string[]> {
  try {
    return await withSignal(signal, () => readdir(dir));
  } catch (err) {
    if (isAbortError(err)) throw err;
    return [];
  }
}

async function walkFiles(
  dir: string,
  cb: (filePath: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let entries: string[];
  try {
    entries = await withSignal(signal, () => readdir(dir));
  } catch (err) {
    if (isAbortError(err)) throw err;
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      signal?.throwIfAborted();
      const full = resolve(dir, entry);
      let s;
      try {
        s = await withSignal(signal, () => stat(full));
      } catch (err) {
        if (isAbortError(err)) throw err;
        return;
      }
      if (s.isDirectory()) await walkFiles(full, cb, signal);
      else if (s.isFile()) await cb(full);
    }),
  );
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
