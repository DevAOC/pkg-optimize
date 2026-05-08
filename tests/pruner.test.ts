import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShakerCache } from '../src/cache.js';
import { prune, toCamelCase } from '../src/pruner.js';
import type {
  ResolvedPackageConfig,
  StructureConfig,
  UsageMap,
} from '../src/types.js';
import { createWorkspace, type Workspace } from './helpers.js';

const NESTED_STRUCTURE: StructureConfig = {
  layout: 'nested',
  memberDir: 'models',
  naming: 'PascalCase',
  extensions: ['.js', '.d.ts'],
  preserve: [
    'index.js',
    'index.d.ts',
    'types.js',
    'types.d.ts',
    'package.json',
  ],
};

const FLAT_STRUCTURE: StructureConfig = {
  layout: 'flat',
  memberDir: 'models',
  naming: 'PascalCase',
  extensions: ['.js'],
  preserve: ['index.js', 'package.json'],
};

const KEBAB_FLAT_STRUCTURE: StructureConfig = {
  layout: 'flat',
  memberDir: 'operations',
  naming: 'kebab-case',
  extensions: ['.js'],
  preserve: ['index.js', 'package.json'],
};

function buildResolved(
  targetPackage: string,
  structure: StructureConfig,
  allow?: { include?: string[] },
): ResolvedPackageConfig {
  return {
    targetPackage,
    allow,
    patterns: {
      namespace: 'api',
      accessStyle: 'member',
      depth: { member: 1, operation: 2 },
      hooks: [],
    },
    packageStructure: structure,
    scanDirs: ['web'],
    cache: { dir: '.pkg-optimize-cache' },
    watch: { debounceMs: 300, softPruneInDev: true },
  };
}

describe('pruner — nested layout', () => {
  let ws: Workspace;
  let cache: ShakerCache;

  beforeEach(() => {
    ws = createWorkspace();
    ws.installFixturePackage('gadget-nested', '@example/test-app');
    cache = new ShakerCache(
      '.pkg-optimize-cache',
      '@example/test-app',
      ws.root,
    );
    cache.prime();
  });

  afterEach(() => ws.cleanup());

  it('removes a member not in usage map', () => {
    const usageMap: UsageMap = {
      members: new Set(['shopProduct']),
      operations: new Set(['shopProduct.update']),
      files: new Set(),
    };

    const result = prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const liveMembers = resolve(cache.getLivePackageDir(), 'models');
    expect(existsSync(resolve(liveMembers, 'ShopProduct'))).toBe(true);
    expect(existsSync(resolve(liveMembers, 'ShopOrder'))).toBe(false);
    expect(existsSync(resolve(liveMembers, 'Customer'))).toBe(false);
    expect(existsSync(resolve(liveMembers, 'UnusedModel'))).toBe(false);
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it('removes unused operation files but keeps allowed ones', () => {
    const usageMap: UsageMap = {
      members: new Set(['shopProduct']),
      operations: new Set(['shopProduct.update']),
      files: new Set(),
    };

    prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const operationsDir = resolve(
      cache.getLivePackageDir(),
      'models',
      'ShopProduct',
      'actions',
    );
    expect(existsSync(resolve(operationsDir, 'update.js'))).toBe(true);
    expect(existsSync(resolve(operationsDir, 'update.d.ts'))).toBe(true);
    expect(existsSync(resolve(operationsDir, 'create.js'))).toBe(false);
    expect(existsSync(resolve(operationsDir, 'delete.js'))).toBe(false);
  });

  it('restores files for symbols added to allow.include after they were removed', () => {
    const usageMap: UsageMap = {
      members: new Set(['shopProduct']),
      operations: new Set(['shopProduct.update']),
      files: new Set(),
    };

    prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });
    const liveMembers = resolve(cache.getLivePackageDir(), 'models');
    expect(existsSync(resolve(liveMembers, 'Customer'))).toBe(false);

    const result = prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE, {
        include: ['customer.create'],
      }),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(existsSync(resolve(liveMembers, 'Customer'))).toBe(true);
    expect(
      existsSync(resolve(liveMembers, 'Customer', 'actions', 'create.js')),
    ).toBe(true);
    expect(result.restored.length).toBeGreaterThan(0);
  });

  it('restores file when usage map references a missing member', () => {
    const liveOrder = resolve(cache.getLivePackageDir(), 'models', 'ShopOrder');
    rmSync(liveOrder, { recursive: true, force: true });

    const usageMap: UsageMap = {
      members: new Set(['shopProduct', 'shopOrder']),
      operations: new Set(['shopOrder.cancel']),
      files: new Set(),
    };

    prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(existsSync(liveOrder)).toBe(true);
    expect(existsSync(resolve(liveOrder, 'ShopOrder.js'))).toBe(true);
    expect(existsSync(resolve(liveOrder, 'actions', 'cancel.js'))).toBe(true);
  });

  it('never removes preserve files', () => {
    const usageMap: UsageMap = {
      members: new Set(),
      operations: new Set(),
      files: new Set(),
    };

    prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, 'index.js'))).toBe(true);
    expect(existsSync(resolve(live, 'index.d.ts'))).toBe(true);
    expect(existsSync(resolve(live, 'types.js'))).toBe(true);
    expect(existsSync(resolve(live, 'package.json'))).toBe(true);
  });

  it('soft mode warns but does not delete; still restores', () => {
    const liveCustomer = resolve(
      cache.getLivePackageDir(),
      'models',
      'Customer',
    );
    rmSync(liveCustomer, { recursive: true, force: true });

    const usageMap: UsageMap = {
      members: new Set(['shopProduct', 'customer']),
      operations: new Set(['customer.create']),
      files: new Set(),
    };

    const result = prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
      soft: true,
    });

    expect(existsSync(liveCustomer)).toBe(true);
    const liveOrder = resolve(cache.getLivePackageDir(), 'models', 'ShopOrder');
    expect(existsSync(liveOrder)).toBe(true);
    expect(result.warnings.some((w) => w.includes('soft mode'))).toBe(true);
    expect(result.removed.length).toBe(0);
  });

  it('returns an accurate PruneResult', () => {
    const usageMap: UsageMap = {
      members: new Set(['shopProduct']),
      operations: new Set(['shopProduct.update']),
      files: new Set(),
    };

    const result = prune({
      usageMap,
      config: buildResolved('@example/test-app', NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(result.packageName).toBe('@example/test-app');
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.restored)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
  });
});

describe('pruner — flat layout', () => {
  let ws: Workspace;
  let cache: ShakerCache;

  beforeEach(() => {
    ws = createWorkspace();
    ws.installFixturePackage('gadget-flat', '@example/flat-app');
    cache = new ShakerCache(
      '.pkg-optimize-cache',
      '@example/flat-app',
      ws.root,
    );
    cache.prime();
  });

  afterEach(() => ws.cleanup());

  it('removes unused member files in a flat layout', () => {
    const usageMap: UsageMap = {
      members: new Set(['shopProduct']),
      operations: new Set(),
      files: new Set(),
    };

    prune({
      usageMap,
      config: buildResolved('@example/flat-app', FLAT_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const liveMembers = resolve(cache.getLivePackageDir(), 'models');
    expect(existsSync(resolve(liveMembers, 'ShopProduct.js'))).toBe(true);
    expect(existsSync(resolve(liveMembers, 'ShopOrder.js'))).toBe(false);
    expect(existsSync(resolve(liveMembers, 'Customer.js'))).toBe(false);
  });

  it('matches kebab-case filenames against camelCase usage symbols', () => {
    ws.installFixturePackage('apollo-flat', '@example/kebab-client');
    const apolloCache = new ShakerCache(
      '.pkg-optimize-cache',
      '@example/kebab-client',
      ws.root,
    );
    apolloCache.prime();

    const usageMap: UsageMap = {
      members: new Set(['GetProduct', 'UpdateProduct']),
      operations: new Set(),
      files: new Set(),
    };

    prune({
      usageMap,
      config: buildResolved('@example/kebab-client', KEBAB_FLAT_STRUCTURE),
      sourceDir: apolloCache.getCachedPackageDir(),
      targetDir: apolloCache.getLivePackageDir(),
    });

    const live = resolve(apolloCache.getLivePackageDir(), 'operations');
    expect(existsSync(resolve(live, 'get-product.js'))).toBe(true);
    expect(existsSync(resolve(live, 'update-product.js'))).toBe(true);
    expect(existsSync(resolve(live, 'list-orders.js'))).toBe(false);
  });
});

describe('pruner — barrel layout', () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it('emits a warning and skips for barrel layout', () => {
    const pkgRoot = resolve(ws.root, 'node_modules', 'barrel-pkg');
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      resolve(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'barrel-pkg', main: 'index.js' }),
    );
    writeFileSync(resolve(pkgRoot, 'index.js'), `export const api = {};`);

    const cache = new ShakerCache('.pkg-optimize-cache', 'barrel-pkg', ws.root);
    cache.prime();

    const result = prune({
      usageMap: { members: new Set(), operations: new Set(), files: new Set() },
      config: buildResolved('barrel-pkg', {
        layout: 'barrel',
        naming: 'PascalCase',
        extensions: ['.js'],
        preserve: ['index.js', 'package.json'],
      }),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(result.warnings.some((w) => w.includes('barrel'))).toBe(true);
    expect(result.removed.length).toBe(0);
  });
});

describe('toCamelCase', () => {
  it('handles PascalCase', () => {
    expect(toCamelCase('ShopProduct')).toBe('shopProduct');
  });
  it('handles kebab-case', () => {
    expect(toCamelCase('get-product')).toBe('getProduct');
  });
  it('handles snake_case', () => {
    expect(toCamelCase('get_product_by_id')).toBe('getProductById');
  });
  it('passes through camelCase unchanged', () => {
    expect(toCamelCase('shopProduct')).toBe('shopProduct');
  });
});
