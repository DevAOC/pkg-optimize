import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = resolve(__dirname, 'fixtures');
const PACKAGE_FIXTURES = resolve(FIXTURES_DIR, 'packages');
const SOURCE_FIXTURES = resolve(FIXTURES_DIR, 'source');

export interface Workspace {
  root: string;
  /** Copy a fake package fixture into the workspace's node_modules under `targetPackage`. */
  installFixturePackage(fixtureName: string, targetPackage: string): string;
  /**
   * Like `installFixturePackage`, but the live path under `node_modules` is a
   * symlink to a real directory (simulates pnpm / some hoisted layouts).
   */
  installFixturePackageSymlinked(fixtureName: string, targetPackage: string): string;
  /** Copy the test source fixtures into the workspace. */
  installFixtureSource(opts?: { dirs?: string[] }): void;
  /** Create a `pkg-optimize.config.json` file. */
  writeConfig(config: object): string;
  cleanup(): void;
}

export function createWorkspace(): Workspace {
  const root = mkdtempSync(resolve(tmpdir(), 'pkg-optimize-test-'));

  return {
    root,
    installFixturePackage(fixtureName, targetPackage) {
      const src = resolve(PACKAGE_FIXTURES, fixtureName);
      const dest = resolve(root, 'node_modules', targetPackage);
      mkdirSync(resolve(root, 'node_modules'), { recursive: true });
      cpSync(src, dest, { recursive: true });
      return dest;
    },
    installFixturePackageSymlinked(fixtureName, targetPackage) {
      const src = resolve(PACKAGE_FIXTURES, fixtureName);
      const linkPath = resolve(root, 'node_modules', targetPackage);
      const realDest = resolve(root, '.fixture-store', targetPackage);
      mkdirSync(dirname(realDest), { recursive: true });
      cpSync(src, realDest, { recursive: true });
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(realDest, linkPath, 'dir');
      return linkPath;
    },
    installFixtureSource(opts) {
      const dirs = opts?.dirs ?? ['web', 'extensions'];
      for (const dir of dirs) {
        const src = resolve(SOURCE_FIXTURES, dir);
        if (existsSync(src)) {
          cpSync(src, resolve(root, dir), { recursive: true });
        }
      }
    },
    writeConfig(config) {
      const path = resolve(root, 'pkg-optimize.config.json');
      writeFileSync(path, JSON.stringify(config, null, 2));
      return path;
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

export const FIXTURE_PATHS = {
  fixtures: FIXTURES_DIR,
  packages: PACKAGE_FIXTURES,
  source: SOURCE_FIXTURES,
};
