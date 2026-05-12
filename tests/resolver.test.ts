import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepMerge, resolvePackageConfig } from "../src/resolver";
import type { ShakerConfig } from "../src/types";
import { createWorkspace, type Workspace } from "./helpers";

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
          targetPackage: "@gadget-client/test-app",
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
      packages: [{ targetPackage: "@gadget-client/flat-app" }],
    };

    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    // Preset says layout: nested. Detected says: flat. Detected wins.
    expect(resolved.packageStructure.layout).toBe("flat");
  });

  it("preset values override built-in defaults", async () => {
    // Without explicit detection (package not installed), preset should apply.
    const top: ShakerConfig = {
      scanDirs: ["web"],
      packages: [{ targetPackage: "@gadget-client/missing" }],
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
          targetPackage: "@gadget-client/test-app",
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
      packages: [{ targetPackage: "@gadget-client/test-app" }],
    };

    const resolved = await resolvePackageConfig(top.packages[0]!, top, ws.root);
    expect(resolved.scanDirs).toEqual(["web"]);
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
