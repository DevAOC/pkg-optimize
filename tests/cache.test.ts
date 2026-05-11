import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShakerCache } from '../src/cache.js';
import { createWorkspace, type Workspace } from './helpers.js';

describe('ShakerCache.reprime', () => {
  let ws: Workspace;
  let cache: ShakerCache;
  let livePkgDir: string;

  beforeEach(async () => {
    ws = createWorkspace();
    livePkgDir = ws.installFixturePackage(
      'gadget-nested',
      '@gadget-client/test-app',
    );
    cache = new ShakerCache(
      '.pkg-optimize-cache',
      '@gadget-client/test-app',
      ws.root,
    );
    await cache.prime();
  });

  afterEach(() => ws.cleanup());

  it('returns false when nothing has changed', async () => {
    expect(await cache.reprime()).toBe(false);
  });

  it('reprimes when package.json mtime is newer (the install case)', async () => {
    const livePkgJson = resolve(livePkgDir, 'package.json');
    const future = new Date(Date.now() + 60_000);
    utimesSync(livePkgJson, future, future);

    expect(await cache.reprime()).toBe(true);
  });

  it(
    'does NOT reprime by default when only model files change ' +
      '(the bug we are fixing — covered by force: true below)',
    async () => {
      // Simulate `ggt` adding a new model: write into the live dir without
      // touching package.json. Without `force`, the mtime fast path returns
      // false and the cache stays stale.
      mkdirSync(resolve(livePkgDir, 'models', 'NewModel'), { recursive: true });
      writeFileSync(
        resolve(livePkgDir, 'models', 'NewModel', 'NewModel.js'),
        'module.exports = {};',
      );

      expect(await cache.reprime()).toBe(false);

      const cachedNewModel = resolve(
        cache.getCachedPackageDir(),
        'models',
        'NewModel',
      );
      expect(existsSync(cachedNewModel)).toBe(false);
    },
  );

  it('reprimes when forced — picks up newly-added model files', async () => {
    mkdirSync(resolve(livePkgDir, 'models', 'NewModel'), { recursive: true });
    writeFileSync(
      resolve(livePkgDir, 'models', 'NewModel', 'NewModel.js'),
      'module.exports = {};',
    );

    expect(await cache.reprime({ force: true })).toBe(true);

    const cachedNewModel = resolve(
      cache.getCachedPackageDir(),
      'models',
      'NewModel',
      'NewModel.js',
    );
    expect(existsSync(cachedNewModel)).toBe(true);
  });

  it('reprimes when forced — drops models that were removed from live', async () => {
    // Confirm Customer is in cache from the initial prime.
    const cachedCustomer = resolve(
      cache.getCachedPackageDir(),
      'models',
      'Customer',
    );
    expect(existsSync(cachedCustomer)).toBe(true);

    // Simulate Gadget removing the model.
    rmSync(resolve(livePkgDir, 'models', 'Customer'), {
      recursive: true,
      force: true,
    });

    expect(await cache.reprime({ force: true })).toBe(true);
    expect(existsSync(cachedCustomer)).toBe(false);
  });

  it('forced reprime returns false when the live package is missing', async () => {
    rmSync(livePkgDir, { recursive: true, force: true });
    expect(await cache.reprime({ force: true })).toBe(false);
  });

  it('forced reprime fully replaces the cache (no stale entries left over)', async () => {
    rmSync(resolve(livePkgDir, 'models', 'ShopOrder'), {
      recursive: true,
      force: true,
    });
    mkdirSync(resolve(livePkgDir, 'models', 'BrandNew'), { recursive: true });
    writeFileSync(
      resolve(livePkgDir, 'models', 'BrandNew', 'BrandNew.js'),
      'module.exports = {};',
    );

    expect(await cache.reprime({ force: true })).toBe(true);

    const cachedModels = resolve(cache.getCachedPackageDir(), 'models');
    const cachedEntries = readdirSync(cachedModels);
    expect(cachedEntries).toContain('BrandNew');
    expect(cachedEntries).not.toContain('ShopOrder');
  });
});
