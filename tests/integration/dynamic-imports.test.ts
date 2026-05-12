import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShakerCache } from "../../src/cache";
import { prune } from "../../src/pruner";
import { scanFile } from "../../src/scanner";
import type {
  PatternsConfig,
  ResolvedPackageConfig,
  StructureConfig,
  UsageMap,
} from "../../src/types";
import { createWorkspace, type Workspace } from "../helpers";

const PATTERNS: PatternsConfig = {
  namespace: "_",
  accessStyle: "destructure",
  depth: { member: 1, operation: 2 },
};

const STRUCTURE: StructureConfig = {
  layout: "destructure",
  memberDir: ".",
  naming: "camelCase",
  extensions: [".js", ".d.ts"],
  preserve: ["index.js", "package.json"],
};

function emptyUsage(): UsageMap {
  return { members: new Set(), operations: new Set(), files: new Set() };
}

function buildResolved(targetPackage: string): ResolvedPackageConfig {
  return {
    targetPackage,
    patterns: PATTERNS,
    packageStructure: STRUCTURE,
    scanDirs: ["src"],
    cache: { dir: ".pkg-optimize-cache" },
    watch: { debounceMs: 300, softPruneInDev: true },
  };
}

describe("scanner — dynamic imports (string literal)", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it('records await import("pkg/sub") as a file ref', async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `const m = await import('lodash-es/debounce');`);
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.files.has("debounce")).toBe(true);
    expect(usage.wildcard).not.toBe(true);
  });

  it('records require("pkg/sub") as a file ref', async () => {
    const f = resolve(ws.root, "a.cjs");
    writeFileSync(f, `const debounce = require('lodash-es/debounce');`);
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.files.has("debounce")).toBe(true);
  });

  it('records require.resolve("pkg/sub") as a file ref', async () => {
    const f = resolve(ws.root, "a.cjs");
    writeFileSync(f, `const path = require.resolve('lodash-es/throttle');`);
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.files.has("throttle")).toBe(true);
  });

  it("strips file extensions from dynamic deep imports", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `await import('pkg/sub/file.mjs');`);
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "pkg" });
    expect(usage.files.has("sub/file")).toBe(true);
  });

  it('sets wildcard for await import("pkg") (top-level dynamic, no subpath)', async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `const _ = await import('lodash-es');`);
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.wildcard).toBe(true);
  });

  it('sets wildcard for require("pkg") (top-level CJS require)', async () => {
    const f = resolve(ws.root, "a.cjs");
    writeFileSync(f, `const _ = require('lodash-es');`);
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.wildcard).toBe(true);
  });

  it("ignores dynamic imports of other packages", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      `await import('react');
       require('something-else');
       await import('other-pkg/foo');`
    );
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.wildcard).not.toBe(true);
    expect(usage.files.size).toBe(0);
  });
});

describe("scanner — dynamic imports (template literal)", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("records the static prefix as a file ref", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      'const name = "FaUser"; const M = await import(`react-icons/fa/${name}`);'
    );
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "react-icons" });
    expect(usage.files.has("fa")).toBe(true);
    // Recording the prefix as a file ref keeps the whole `fa/` dir alive
    // (because pathMatchesFiles matches descendants).
    expect(usage.wildcard).not.toBe(true);
  });

  it("sets wildcard for `${pkg}/...` (target name spans the dynamic portion)", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      'const sub = "debounce"; await import(`lodash-es/${sub}`);'
    );
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.wildcard).toBe(true);
  });

  it("ignores template literals whose prefix does not reach the target", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      'const x = "y"; await import(`./locale/${x}/index.js`); await import(`other-pkg/${x}`);'
    );
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.wildcard).not.toBe(true);
    expect(usage.files.size).toBe(0);
  });
});

describe("scanner — dynamic imports (fully variable arg)", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("does NOT trigger wildcard when the arg is a runtime variable", async () => {
    // Without a static portion we cannot prove the call targets our package,
    // and triggering wildcard for every `import(somePath)` in the codebase
    // would defeat all pruning for everyone.
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      `const path = somePath();
       await import(path);
       require(path);`
    );
    const usage = emptyUsage();
    await scanFile(f, PATTERNS, usage, { targetPackage: "lodash-es" });
    expect(usage.wildcard).not.toBe(true);
    expect(usage.files.size).toBe(0);
  });
});

describe("pruner — wildcard mode (dynamic import escape hatch)", () => {
  let ws: Workspace;
  let cache: ShakerCache;

  beforeEach(async () => {
    ws = createWorkspace();
    ws.installFixturePackage("destructure-flat", "@example/destructure-pkg");
    cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@example/destructure-pkg",
      ws.root
    );
    await cache.prime();
  });

  afterEach(() => ws.cleanup());

  it("does not remove anything when wildcard is set", async () => {
    const usage: UsageMap = {
      members: new Set(["debounce"]), // only one member referenced normally
      operations: new Set(),
      files: new Set(),
      wildcard: true,
    };

    const result = await prune({
      usageMap: usage,
      config: buildResolved("@example/destructure-pkg"),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "debounce.js"))).toBe(true);
    expect(existsSync(resolve(live, "throttle.js"))).toBe(true);
    expect(existsSync(resolve(live, "filter.js"))).toBe(true);
    expect(existsSync(resolve(live, "reduce.js"))).toBe(true);
    expect(existsSync(resolve(live, "zip.js"))).toBe(true);
    expect(result.removed.length).toBe(0);
    expect(result.warnings.some((w) => w.includes("dynamic import"))).toBe(
      true
    );
  });

  it("restores previously-removed files when wildcard is later set", async () => {
    // First pass: prune everything except debounce.
    await prune({
      usageMap: {
        members: new Set(["debounce"]),
        operations: new Set(),
        files: new Set(),
      },
      config: buildResolved("@example/destructure-pkg"),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });
    expect(existsSync(resolve(cache.getLivePackageDir(), "throttle.js"))).toBe(
      false
    );
    expect(existsSync(resolve(cache.getLivePackageDir(), "filter.js"))).toBe(
      false
    );

    // Now: a dynamic import was added to source — wildcard kicks in, restore everything.
    const result = await prune({
      usageMap: {
        members: new Set(),
        operations: new Set(),
        files: new Set(),
        wildcard: true,
      },
      config: buildResolved("@example/destructure-pkg"),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "throttle.js"))).toBe(true);
    expect(existsSync(resolve(live, "filter.js"))).toBe(true);
    expect(existsSync(resolve(live, "reduce.js"))).toBe(true);
    expect(existsSync(resolve(live, "zip.js"))).toBe(true);
    expect(result.restored.length).toBeGreaterThan(0);
    expect(result.removed.length).toBe(0);
  });

  it("still restores even when the live package was deleted entirely", async () => {
    rmSync(cache.getLivePackageDir(), { recursive: true, force: true });

    await prune({
      usageMap: {
        members: new Set(),
        operations: new Set(),
        files: new Set(),
        wildcard: true,
      },
      config: buildResolved("@example/destructure-pkg"),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "debounce.js"))).toBe(true);
    expect(existsSync(resolve(live, "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "package.json"))).toBe(true);
  });
});
