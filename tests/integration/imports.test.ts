import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShakerCache } from "../../src/cache";
import { prune } from "../../src/pruner";
import { scanFile } from "../../src/scanner";
import type {
  DetectedConfig,
  PatternsConfig,
  ResolvedPackageConfig,
  StructureConfig,
  UsageMap,
} from "../../src/types";
import { createWorkspace, type Workspace } from "../helpers";

const DESTRUCTURE_PATTERNS: PatternsConfig = {
  namespace: "_",
  accessStyle: "destructure",
  depth: { member: 1, operation: 2 },
};

const DESTRUCTURE_STRUCTURE: StructureConfig = {
  layout: "destructure",
  memberDir: ".",
  naming: "camelCase",
  extensions: [".js", ".d.ts"],
  preserve: ["index.js", "package.json"],
};

function emptyUsage(): UsageMap {
  return { members: new Set(), operations: new Set(), files: new Set() };
}

const TEST_DETECTED: DetectedConfig = { confidence: "high" };

function buildResolved(
  target: string,
  structure: StructureConfig,
  patterns: PatternsConfig = DESTRUCTURE_PATTERNS,
  allow?: { include?: string[] }
): ResolvedPackageConfig {
  return {
    target,
    allow,
    patterns,
    packageStructure: structure,
    scanDirs: ["src"],
    cache: { dir: ".pkg-optimize-cache" },
    watch: { debounceMs: 300, softPruneInDev: true },
    detected: TEST_DETECTED,
  };
}

describe("scanner — import tracking", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("records named imports as members", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `import { debounce, throttle } from 'lodash-es';`);
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage, {
      target: "lodash-es",
    });
    expect(usage.members.has("debounce")).toBe(true);
    expect(usage.members.has("throttle")).toBe(true);
  });

  it("uses the imported name (not the local alias)", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `import { debounce as d } from 'lodash-es';`);
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage, {
      target: "lodash-es",
    });
    expect(usage.members.has("debounce")).toBe(true);
    expect(usage.members.has("d")).toBe(false);
  });

  it("binds default imports as a dynamic namespace for member access", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      `import _ from 'lodash';
       _.debounce(() => {}, 100);
       _.throttle(() => {}, 100);`
    );
    const usage = emptyUsage();
    await scanFile(
      f,
      { ...DESTRUCTURE_PATTERNS, namespace: "irrelevant" },
      usage,
      { target: "lodash" }
    );
    expect(usage.members.has("debounce")).toBe(true);
    expect(usage.members.has("throttle")).toBe(true);
  });

  it("binds namespace imports (`import * as X`) the same way", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      `import * as dateFns from 'date-fns';
       dateFns.format(new Date());
       dateFns.parseISO('2024-01-01');`
    );
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage, {
      target: "date-fns",
    });
    expect(usage.members.has("format")).toBe(true);
    expect(usage.members.has("parseISO")).toBe(true);
  });

  it("records deep imports as file references", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      `import { format } from 'date-fns/format';
       import addDays from 'date-fns/addDays';`
    );
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage, {
      target: "date-fns",
    });
    expect(usage.files.has("format")).toBe(true);
    expect(usage.files.has("addDays")).toBe(true);
  });

  it("records side-effect imports as file references", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `import 'react-spectrum/Button/style.css';`);
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage, {
      target: "react-spectrum",
    });
    expect(usage.files.has("Button/style")).toBe(true);
  });

  it("strips the file extension from deep import paths", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `import x from 'pkg/sub/file.mjs';`);
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage, { target: "pkg" });
    expect(usage.files.has("sub/file")).toBe(true);
  });

  it("ignores imports from packages other than the target", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(
      f,
      `import { debounce } from 'lodash-es';
       import { useState } from 'react';
       import { Button } from '@my/ui';`
    );
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage, {
      target: "lodash-es",
    });
    expect(usage.members.has("debounce")).toBe(true);
    expect(usage.members.has("useState")).toBe(false);
    expect(usage.members.has("Button")).toBe(false);
  });

  it("does no import tracking when target is omitted", async () => {
    const f = resolve(ws.root, "a.ts");
    writeFileSync(f, `import { debounce } from 'lodash-es';`);
    const usage = emptyUsage();
    await scanFile(f, DESTRUCTURE_PATTERNS, usage);
    expect(usage.members.size).toBe(0);
  });
});

describe("pruner — destructure layout", () => {
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

  it("removes top-level files not in the usage map", async () => {
    const usage: UsageMap = {
      members: new Set(["debounce", "map"]),
      operations: new Set(),
      files: new Set(),
    };

    await prune({
      usageMap: usage,
      config: buildResolved("@example/destructure-pkg", DESTRUCTURE_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "debounce.js"))).toBe(true);
    expect(existsSync(resolve(live, "map.js"))).toBe(true);
    expect(existsSync(resolve(live, "throttle.js"))).toBe(false);
    expect(existsSync(resolve(live, "filter.js"))).toBe(false);
    expect(existsSync(resolve(live, "reduce.js"))).toBe(false);
    expect(existsSync(resolve(live, "zip.js"))).toBe(false);
    expect(existsSync(resolve(live, "index.js"))).toBe(true); // preserved
    expect(existsSync(resolve(live, "package.json"))).toBe(true); // preserved
  });

  it("keeps a top-level file referenced via deep import (usageMap.files)", async () => {
    const usage: UsageMap = {
      members: new Set(),
      operations: new Set(),
      files: new Set(["debounce"]),
    };

    await prune({
      usageMap: usage,
      config: buildResolved("@example/destructure-pkg", DESTRUCTURE_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "debounce.js"))).toBe(true);
    expect(existsSync(resolve(live, "throttle.js"))).toBe(false);
  });

  it("restores a previously-removed file when it shows back up in usage", async () => {
    const usage1: UsageMap = {
      members: new Set(["debounce"]),
      operations: new Set(),
      files: new Set(),
    };

    await prune({
      usageMap: usage1,
      config: buildResolved("@example/destructure-pkg", DESTRUCTURE_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });
    expect(existsSync(resolve(cache.getLivePackageDir(), "throttle.js"))).toBe(
      false
    );

    const usage2: UsageMap = {
      members: new Set(["debounce", "throttle"]),
      operations: new Set(),
      files: new Set(),
    };

    const result = await prune({
      usageMap: usage2,
      config: buildResolved("@example/destructure-pkg", DESTRUCTURE_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(existsSync(resolve(cache.getLivePackageDir(), "throttle.js"))).toBe(
      true
    );
    expect(result.restored.length).toBeGreaterThan(0);
  });

  it("handles allow.include with explicit file paths", async () => {
    const usage: UsageMap = {
      members: new Set(),
      operations: new Set(),
      files: new Set(),
    };

    await prune({
      usageMap: usage,
      config: buildResolved(
        "@example/destructure-pkg",
        DESTRUCTURE_STRUCTURE,
        DESTRUCTURE_PATTERNS,
        { include: ["filter", "reduce"] }
      ),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "filter.js"))).toBe(true);
    expect(existsSync(resolve(live, "reduce.js"))).toBe(true);
    expect(existsSync(resolve(live, "debounce.js"))).toBe(false);
  });
});

describe("pruner — destructure layout with subdirs", () => {
  let ws: Workspace;
  let cache: ShakerCache;

  beforeEach(async () => {
    ws = createWorkspace();
    ws.installFixturePackage("destructure-mixed", "@example/mixed-pkg");
    cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@example/mixed-pkg",
      ws.root
    );
    await cache.prime();
  });

  afterEach(() => ws.cleanup());

  it("keeps directory members and removes the rest", async () => {
    const usage: UsageMap = {
      members: new Set(["format", "addDays"]),
      operations: new Set(),
      files: new Set(),
    };

    await prune({
      usageMap: usage,
      config: buildResolved("@example/mixed-pkg", DESTRUCTURE_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "format", "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "addDays.js"))).toBe(true);
    expect(existsSync(resolve(live, "parseISO"))).toBe(false);
    expect(existsSync(resolve(live, "subDays.js"))).toBe(false);
    expect(existsSync(resolve(live, "locale"))).toBe(false);
  });

  it("keeps a directory referenced via a deep import file ref", async () => {
    const usage: UsageMap = {
      members: new Set(),
      operations: new Set(),
      files: new Set(["format", "locale/index"]),
    };

    await prune({
      usageMap: usage,
      config: buildResolved("@example/mixed-pkg", DESTRUCTURE_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "format", "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "locale", "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "parseISO"))).toBe(false);
  });
});
