import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShakerCache } from "../src/cache";
import { prune } from "../src/pruner";
import { toCamelCase } from "../src/utils";
import type {
  DetectedConfig,
  ResolvedPackageConfig,
  StructureConfig,
  UsageMap,
} from "../src/types";
import { createWorkspace, type Workspace } from "./helpers";

const NESTED_STRUCTURE: StructureConfig = {
  layout: "nested",
  memberDir: "models",
  naming: "PascalCase",
  extensions: [".js", ".d.ts"],
  preserve: [
    "index.js",
    "index.d.ts",
    "types.js",
    "types.d.ts",
    "package.json",
  ],
};

const FLAT_STRUCTURE: StructureConfig = {
  layout: "flat",
  memberDir: "models",
  naming: "PascalCase",
  extensions: [".js"],
  preserve: ["index.js", "package.json"],
};

const KEBAB_FLAT_STRUCTURE: StructureConfig = {
  layout: "flat",
  memberDir: "operations",
  naming: "kebab-case",
  extensions: [".js"],
  preserve: ["index.js", "package.json"],
};

const TEST_DETECTED: DetectedConfig = { confidence: "high" };

function buildResolved(
  target: string,
  structure: StructureConfig,
  allow?: { include?: string[] }
): ResolvedPackageConfig {
  return {
    target,
    allow,
    patterns: {
      namespace: "api",
      accessStyle: "member",
      depth: { member: 1, operation: 2 },
      hooks: [],
    },
    packageStructure: structure,
    scanDirs: ["web"],
    cache: { dir: ".pkg-optimize-cache" },
    watch: { debounceMs: 300, softPruneInDev: true },
    detected: TEST_DETECTED,
  };
}

describe("pruner — nested layout", () => {
  let ws: Workspace;
  let cache: ShakerCache;

  beforeEach(async () => {
    ws = createWorkspace();
    ws.installFixturePackage("gadget-nested", "@example/test-app");
    cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@example/test-app",
      ws.root
    );
    await cache.prime();
  });

  afterEach(() => ws.cleanup());

  it("removes a member not in usage map", async () => {
    const usageMap: UsageMap = {
      members: new Set(["shopProduct"]),
      operations: new Set(["shopProduct.update"]),
      files: new Set(),
    };

    const result = await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const liveMembers = resolve(cache.getLivePackageDir(), "models");
    expect(existsSync(resolve(liveMembers, "ShopProduct"))).toBe(true);
    expect(existsSync(resolve(liveMembers, "ShopOrder"))).toBe(false);
    expect(existsSync(resolve(liveMembers, "Customer"))).toBe(false);
    expect(existsSync(resolve(liveMembers, "UnusedModel"))).toBe(false);
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it("removes unused operation files but keeps allowed ones", async () => {
    const usageMap: UsageMap = {
      members: new Set(["shopProduct"]),
      operations: new Set(["shopProduct.update"]),
      files: new Set(),
    };

    await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const operationsDir = resolve(
      cache.getLivePackageDir(),
      "models",
      "ShopProduct",
      "actions"
    );
    expect(existsSync(resolve(operationsDir, "update.js"))).toBe(true);
    expect(existsSync(resolve(operationsDir, "update.d.ts"))).toBe(true);
    expect(existsSync(resolve(operationsDir, "create.js"))).toBe(false);
    expect(existsSync(resolve(operationsDir, "delete.js"))).toBe(false);
  });

  it("restores files for symbols added to allow.include after they were removed", async () => {
    const usageMap: UsageMap = {
      members: new Set(["shopProduct"]),
      operations: new Set(["shopProduct.update"]),
      files: new Set(),
    };

    await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });
    const liveMembers = resolve(cache.getLivePackageDir(), "models");
    expect(existsSync(resolve(liveMembers, "Customer"))).toBe(false);

    const result = await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE, {
        include: ["customer.create"],
      }),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(existsSync(resolve(liveMembers, "Customer"))).toBe(true);
    expect(
      existsSync(resolve(liveMembers, "Customer", "actions", "create.js"))
    ).toBe(true);
    expect(result.restored.length).toBeGreaterThan(0);
  });

  it("restores file when usage map references a missing member", async () => {
    const liveOrder = resolve(cache.getLivePackageDir(), "models", "ShopOrder");
    rmSync(liveOrder, { recursive: true, force: true });

    const usageMap: UsageMap = {
      members: new Set(["shopProduct", "shopOrder"]),
      operations: new Set(["shopOrder.cancel"]),
      files: new Set(),
    };

    await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(existsSync(liveOrder)).toBe(true);
    expect(existsSync(resolve(liveOrder, "ShopOrder.js"))).toBe(true);
    expect(existsSync(resolve(liveOrder, "actions", "cancel.js"))).toBe(true);
  });

  it("never removes preserve files", async () => {
    const usageMap: UsageMap = {
      members: new Set(),
      operations: new Set(),
      files: new Set(),
    };

    await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    expect(existsSync(resolve(live, "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "index.d.ts"))).toBe(true);
    expect(existsSync(resolve(live, "types.js"))).toBe(true);
    expect(existsSync(resolve(live, "package.json"))).toBe(true);
  });

  it("soft mode warns but does not delete; still restores", async () => {
    const liveCustomer = resolve(
      cache.getLivePackageDir(),
      "models",
      "Customer"
    );
    rmSync(liveCustomer, { recursive: true, force: true });

    const usageMap: UsageMap = {
      members: new Set(["shopProduct", "customer"]),
      operations: new Set(["customer.create"]),
      files: new Set(),
    };

    const result = await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
      soft: true,
    });

    expect(existsSync(liveCustomer)).toBe(true);
    const liveOrder = resolve(cache.getLivePackageDir(), "models", "ShopOrder");
    expect(existsSync(liveOrder)).toBe(true);
    expect(result.warnings.some((w) => w.includes("soft mode"))).toBe(true);
    expect(result.removed.length).toBe(0);
  });

  it("returns an accurate PruneResult", async () => {
    const usageMap: UsageMap = {
      members: new Set(["shopProduct"]),
      operations: new Set(["shopProduct.update"]),
      files: new Set(),
    };

    const result = await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(result.packageName).toBe("@example/test-app");
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.restored)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
  });
});

describe("pruner — flat layout", () => {
  let ws: Workspace;
  let cache: ShakerCache;

  beforeEach(async () => {
    ws = createWorkspace();
    ws.installFixturePackage("gadget-flat", "@example/flat-app");
    cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@example/flat-app",
      ws.root
    );
    await cache.prime();
  });

  afterEach(() => ws.cleanup());

  it("removes unused member files in a flat layout", async () => {
    const usageMap: UsageMap = {
      members: new Set(["shopProduct"]),
      operations: new Set(),
      files: new Set(),
    };

    await prune({
      usageMap,
      config: buildResolved("@example/flat-app", FLAT_STRUCTURE),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const liveMembers = resolve(cache.getLivePackageDir(), "models");
    expect(existsSync(resolve(liveMembers, "ShopProduct.js"))).toBe(true);
    expect(existsSync(resolve(liveMembers, "ShopOrder.js"))).toBe(false);
    expect(existsSync(resolve(liveMembers, "Customer.js"))).toBe(false);
  });

  it("matches kebab-case filenames against camelCase usage symbols", async () => {
    ws.installFixturePackage("apollo-flat", "@example/kebab-client");
    const apolloCache = new ShakerCache(
      ".pkg-optimize-cache",
      "@example/kebab-client",
      ws.root
    );
    await apolloCache.prime();

    const usageMap: UsageMap = {
      members: new Set(["GetProduct", "UpdateProduct"]),
      operations: new Set(),
      files: new Set(),
    };

    await prune({
      usageMap,
      config: buildResolved("@example/kebab-client", KEBAB_FLAT_STRUCTURE),
      sourceDir: apolloCache.getCachedPackageDir(),
      targetDir: apolloCache.getLivePackageDir(),
    });

    const live = resolve(apolloCache.getLivePackageDir(), "operations");
    expect(existsSync(resolve(live, "get-product.js"))).toBe(true);
    expect(existsSync(resolve(live, "update-product.js"))).toBe(true);
    expect(existsSync(resolve(live, "list-orders.js"))).toBe(false);
  });
});

describe("pruner — barrel layout", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("does not remove files from a single-file barrel when nothing is referenced", async () => {
    const pkgRoot = resolve(ws.root, "node_modules", "barrel-pkg");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      resolve(pkgRoot, "package.json"),
      JSON.stringify({ name: "barrel-pkg", main: "index.js" })
    );
    writeFileSync(resolve(pkgRoot, "index.js"), `export const api = {};`);

    const cache = new ShakerCache(".pkg-optimize-cache", "barrel-pkg", ws.root);
    await cache.prime();

    const result = await prune({
      usageMap: { members: new Set(), operations: new Set(), files: new Set() },
      config: buildResolved("barrel-pkg", {
        layout: "barrel",
        naming: "PascalCase",
        extensions: [".js"],
        preserve: ["index.js", "package.json"],
      }),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    expect(result.removed.length).toBe(0);
    expect(
      result.warnings.filter((w) => w.toLowerCase().includes("analysis failed"))
    ).toHaveLength(0);
  });

  it("preserves every resolved entry from a dual-bundle exports map (ESM + CJS + types)", async () => {
    ws.installFixturePackage(
      "gadget-dual-bundle",
      "@example/gadget-dual-bundle",
    );
    const cache = new ShakerCache(
      ".pkg-optimize-cache",
      "@example/gadget-dual-bundle",
      ws.root,
    );
    await cache.prime();

    const result = await prune({
      usageMap: {
        members: new Set(["customer"]),
        operations: new Set(),
        files: new Set(),
      },
      config: buildResolved("@example/gadget-dual-bundle", {
        layout: "barrel",
        naming: "PascalCase",
        extensions: [".js", ".d.ts"],
        preserve: [
          "index.js",
          "index.d.ts",
          "types.js",
          "types.d.ts",
          "package.json",
        ],
      }),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const live = cache.getLivePackageDir();
    // Runtime + type entries the package.json declares must all survive —
    // this regressed before the fix: the destructure pruner removed every
    // top-level directory at once.
    expect(existsSync(resolve(live, "dist-esm", "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "dist-cjs", "index.js"))).toBe(true);
    expect(existsSync(resolve(live, "types", "index.d.ts"))).toBe(true);
    expect(existsSync(resolve(live, "types-esm", "index.d.ts"))).toBe(true);
    expect(existsSync(resolve(live, "package.json"))).toBe(true);

    // Used member implementation files are kept; unused ones are removed.
    expect(
      existsSync(resolve(live, "dist-esm", "internal", "Customer.js")),
    ).toBe(true);
    expect(
      existsSync(resolve(live, "dist-esm", "internal", "Product.js")),
    ).toBe(false);
    expect(
      result.warnings.filter((w) => w.toLowerCase().includes("analysis failed")),
    ).toHaveLength(0);
  });

  it("rewrites the entry barrel and removes unused implementation files", async () => {
    const pkgRoot = resolve(ws.root, "node_modules", "barrel-multi");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      resolve(pkgRoot, "package.json"),
      JSON.stringify({ name: "barrel-multi", main: "index.js" })
    );
    writeFileSync(
      resolve(pkgRoot, "index.js"),
      `export { a } from './a.js';\nexport { b } from './b.js';\n`
    );
    writeFileSync(resolve(pkgRoot, "a.js"), `export const a = 1;\n`);
    writeFileSync(resolve(pkgRoot, "b.js"), `export const b = 2;\n`);

    const cache = new ShakerCache(
      ".pkg-optimize-cache",
      "barrel-multi",
      ws.root
    );
    await cache.prime();

    const result = await prune({
      usageMap: {
        members: new Set(["a"]),
        operations: new Set(),
        files: new Set(),
      },
      config: buildResolved("barrel-multi", {
        layout: "barrel",
        naming: "camelCase",
        extensions: [".js"],
        preserve: ["package.json"],
      }),
      sourceDir: cache.getCachedPackageDir(),
      targetDir: cache.getLivePackageDir(),
    });

    const liveDir = cache.getLivePackageDir();
    expect(existsSync(resolve(liveDir, "a.js"))).toBe(true);
    expect(existsSync(resolve(liveDir, "b.js"))).toBe(false);
    const indexSrc = readFileSync(resolve(liveDir, "index.js"), "utf8");
    expect(indexSrc).toContain(`'./a.js'`);
    expect(indexSrc).not.toContain(`'./b.js'`);
    expect(
      result.warnings.filter((w) => w.toLowerCase().includes("analysis failed"))
    ).toHaveLength(0);
  });
});

describe("pruner — missing source cache", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("warns and skips when sourceDir does not exist", async () => {
    const usageMap: UsageMap = {
      members: new Set(["shopProduct"]),
      operations: new Set(),
      files: new Set(),
    };
    const bogusSource = resolve(ws.root, ".pkg-optimize-cache", "no-such-copy");
    const result = await prune({
      usageMap,
      config: buildResolved("@example/test-app", NESTED_STRUCTURE),
      sourceDir: bogusSource,
      targetDir: resolve(ws.root, "node_modules", "@example", "test-app"),
    });
    expect(result.warnings.some((w) => /no cache/i.test(w))).toBe(true);
    expect(result.removed).toEqual([]);
  });
});

describe("toCamelCase", () => {
  it("handles PascalCase", () => {
    expect(toCamelCase("ShopProduct")).toBe("shopProduct");
  });
  it("handles kebab-case", () => {
    expect(toCamelCase("get-product")).toBe("getProduct");
  });
  it("handles snake_case", () => {
    expect(toCamelCase("get_product_by_id")).toBe("getProductById");
  });
  it("passes through camelCase unchanged", () => {
    expect(toCamelCase("shopProduct")).toBe("shopProduct");
  });
});
