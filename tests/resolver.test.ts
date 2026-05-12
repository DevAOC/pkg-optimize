import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepMerge, mergeEntryForDetect, resolvePackageConfig } from "../src/resolver";
import type { ShakerConfig } from "../src/types";
import { createWorkspace, FIXTURE_PATHS, type Workspace } from "./helpers";

describe("resolver", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("user config overrides detected values", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    const top: ShakerConfig = {
      scanDirs: ["web"],
      packages: [
        {
          target: "@gadget-client/test-app",
          patterns: {
            namespace: "customApi",
            accessStyle: "member",
            depth: { member: 1, operation: 2 },
          },
        },
      ],
    };

    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    expect(resolved.patterns.namespace).toBe("customApi");
  });

  it("detected values override preset values", async () => {
    ws.installFixturePackage("gadget-flat", "@gadget-client/flat-app");
    const top: ShakerConfig = {
      scanDirs: ["web"],
      packages: [{ target: "@gadget-client/flat-app" }],
    };

    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    // Preset says layout: nested. Detected says: flat. Detected wins.
    expect(resolved.packageStructure.layout).toBe("flat");
  });

  it("preset values override built-in defaults", async () => {
    // Without explicit detection (package not installed), preset should apply.
    const top: ShakerConfig = {
      scanDirs: ["web"],
      packages: [{ target: "@gadget-client/missing" }],
    };

    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    // Built-in default for namespace is "api" — preset also has "api".
    // Built-in layout default is "flat", but preset says "nested" → preset wins.
    expect(resolved.packageStructure.layout).toBe("nested");
    expect(resolved.patterns.hooks?.length ?? 0).toBeGreaterThan(0);
  });

  it("package-level scanDirs overrides top-level", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    const top: ShakerConfig = {
      scanDirs: ["web"],
      packages: [
        {
          target: "@gadget-client/test-app",
          scanDirs: ["extensions"],
        },
      ],
    };

    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    expect(resolved.scanDirs).toEqual(["extensions"]);
  });

  it("inherits top-level scanDirs when package-level not provided", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    const top: ShakerConfig = {
      scanDirs: ["web"],
      packages: [{ target: "@gadget-client/test-app" }],
    };

    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    expect(resolved.scanDirs).toEqual(["web"]);
  });

  it("uses merged preset entry when node_modules entry is broken", async () => {
    const target = "@gadget-client/test-app";
    const nm = resolve(ws.root, "node_modules", target);
    mkdirSync(nm, { recursive: true });
    writeFileSync(
      resolve(nm, "package.json"),
      JSON.stringify({ name: target, main: "./missing-entry.js" }),
    );
    const gadgetDir = resolve(ws.root, ".gadget", "client");
    mkdirSync(gadgetDir, { recursive: true });
    cpSync(resolve(FIXTURE_PATHS.packages, "gadget-nested"), gadgetDir, {
      recursive: true,
    });
    const top: ShakerConfig = {
      scanDirs: ["web"],
      packages: [{ target }],
    };
    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    expect(resolved.detected.skip).not.toBe(true);
    expect(resolved.detected.packageStructure?.layout).toBe("nested");
  });
});

describe("mergeEntryForDetect", () => {
  it("returns a string when only the user supplies a single path", () => {
    expect(mergeEntryForDetect("./vendor/pkg", undefined)).toBe("./vendor/pkg");
  });

  it("returns an array for preset-only hints so misses stay silent", () => {
    expect(mergeEntryForDetect(undefined, [".gadget/client"])).toEqual([
      ".gadget/client",
    ]);
  });

  it("dedupes and preserves user-first order", () => {
    expect(mergeEntryForDetect("a", ["b", "a"], ["c"])).toEqual(["a", "b", "c"]);
  });
});

describe("deepMerge", () => {
  it("later sources override earlier sources", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("merges nested objects recursively", () => {
    expect(
      deepMerge<{ a: { b: number; c: number } }>(
        { a: { b: 1, c: 2 } },
        { a: { c: 3 } }
      )
    ).toEqual({ a: { b: 1, c: 3 } });
  });

  it("replaces arrays wholesale (does not merge them)", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it("skips undefined and null values", () => {
    expect(deepMerge({ a: 1 }, { a: undefined, b: null })).toEqual({ a: 1 });
  });
});
