import {
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShakerCache } from "../src/cache";
import { SCAN_PATTERNS } from "../src/constants";
import { stripExtension } from "../src/files";
import { prune } from "../src/pruner";
import { toCamelCase } from "../src/utils";
import type {
  DetectedConfig,
  ResolvedPackageConfig,
  UsageMap,
} from "../src/types";
import { createWorkspace, type Workspace } from "./helpers";

const TEST_DETECTED: DetectedConfig = { confidence: "high" };

function buildResolved(
  target: string,
  allow?: { include?: string[] }
): ResolvedPackageConfig {
  return {
    target,
    allow,
    patterns: SCAN_PATTERNS,
    scanDirs: ["web", "extensions"],
    cache: { dir: ".pkg-optimize-cache" },
    watch: { debounceMs: 300, softPruneInDev: true },
    detected: TEST_DETECTED,
  };
}

describe("pruner", () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("prunes flat dist-esm models, preserves connection runtime, and rewrites entries", async () => {
    ws.installFixturePackage("gadget-dist-esm", "@gadget-client/dist-app");
    const cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@gadget-client/dist-app",
      ws.root
    );
    await cache.prime();

    const result = await prune({
      usageMap: {
        members: new Set(["shopifyProduct", "session"]),
        operations: new Set(),
        files: new Set(),
      },
      config: buildResolved("@gadget-client/dist-app"),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(
      existsSync(resolve(live, "dist-esm", "models", "ShopifyProduct.js"))
    ).toBe(true);
    expect(existsSync(resolve(live, "dist-esm", "models", "Session.js"))).toBe(
      true
    );
    expect(
      existsSync(resolve(live, "dist-esm", "models", "UnusedModel.js"))
    ).toBe(false);
    expect(
      existsSync(resolve(live, "dist-esm", "connection", "support.js"))
    ).toBe(true);
    expect(existsSync(resolve(live, "dist-esm", "Client.js"))).toBe(true);
    const clientJs = readFileSync(
      resolve(live, "dist-esm", "Client.js"),
      "utf8"
    );
    expect(clientJs).toContain("ShopifyProduct");
    expect(clientJs).toContain("Session");
    expect(clientJs).not.toContain("UnusedModel");

    const esmIndex = readFileSync(
      resolve(live, "dist-esm", "index.js"),
      "utf8"
    );
    expect(esmIndex).toContain("ShopifyProduct");
    expect(esmIndex).not.toContain("UnusedModel");
    expect(
      result.warnings.filter((w) => w.toLowerCase().includes("analysis failed"))
    ).toHaveLength(0);
  });

  it("preserves dual-bundle entry files when pruning gadget-dual-bundle", async () => {
    ws.installFixturePackage(
      "gadget-dual-bundle",
      "@gadget-client/dual-bundle"
    );
    const cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@gadget-client/dual-bundle",
      ws.root
    );
    await cache.prime();

    await prune({
      usageMap: {
        members: new Set(["customer"]),
        operations: new Set(),
        files: new Set(),
      },
      config: buildResolved("@gadget-client/dual-bundle"),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "dist-esm", "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "dist-cjs", "index.js"))).toBe(true);
    expect(
      existsSync(resolve(live, "dist-esm", "internal", "Product.js"))
    ).toBe(false);
  });

  it("restore-only when wildcard is set", async () => {
    ws.installFixturePackage("gadget-dist-esm", "@gadget-client/dist-app");
    const cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@gadget-client/dist-app",
      ws.root
    );
    await cache.prime();
    const liveUnused = resolve(
      cache.getLivePackageDir(),
      "dist-esm",
      "models",
      "UnusedModel.js"
    );
    const { unlinkSync } = await import("node:fs");
    unlinkSync(liveUnused);

    const result = await prune({
      usageMap: {
        members: new Set(),
        operations: new Set(),
        files: new Set(),
        wildcard: true,
      },
      config: buildResolved("@gadget-client/dist-app"),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(existsSync(liveUnused)).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("warns and skips when sourceDir does not exist", async () => {
    const result = await prune({
      usageMap: {
        members: new Set(["shopProduct"]),
        operations: new Set(),
        files: new Set(),
      },
      config: buildResolved("@gadget-client/test-app"),
      sourceDir: resolve(ws.root, ".pkg-optimize-cache", "no-such-copy"),
      targetDir: resolve(ws.root, "node_modules", "@gadget-client", "test-app"),
    });
    expect(result.warnings.some((w) => /no cache/i.test(w))).toBe(true);
  });
});

describe("toCamelCase", () => {
  it("handles PascalCase", () => {
    expect(toCamelCase("ShopProduct")).toBe("shopProduct");
  });
});

describe("stripExtension", () => {
  it("strips .js", () => {
    expect(stripExtension("ShopifyProduct.js")).toBe("ShopifyProduct");
  });

  it("strips .d.ts", () => {
    expect(stripExtension("ShopifyProduct.d.ts")).toBe("ShopifyProduct");
  });
});
