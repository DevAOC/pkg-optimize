import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_PATTERNS } from "../src/constants";
import {
  deepMerge,
  resolveEntryForDetect,
  resolvePackageConfig,
} from "../src/resolver";
import type { ShakerConfig } from "../src/types";
import { createWorkspace, FIXTURE_PATHS, type Workspace } from "./helpers";

describe("resolver", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("always applies hardcoded Gadget scan patterns", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    const resolved = await resolvePackageConfig(
      { target: "@gadget-client/test-app" },
      { packages: [] },
      ws.root
    );
    expect(resolved.patterns).toBe(SCAN_PATTERNS);
    expect(resolved.patterns.namespace).toBe("api");
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

  it("defaults scanDirs to web and extensions", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    const resolved = await resolvePackageConfig(
      { target: "@gadget-client/test-app" },
      { packages: [] },
      ws.root
    );
    expect(resolved.scanDirs).toEqual(["web", "extensions"]);
  });

  it("uses .gadget/client entry when node_modules entry is broken", async () => {
    const target = "@gadget-client/test-app";
    const nm = resolve(ws.root, "node_modules", target);
    mkdirSync(nm, { recursive: true });
    writeFileSync(
      resolve(nm, "package.json"),
      JSON.stringify({ name: target, main: "./missing-entry.js" })
    );
    const gadgetDir = resolve(ws.root, ".gadget", "client");
    mkdirSync(gadgetDir, { recursive: true });
    cpSync(resolve(FIXTURE_PATHS.packages, "gadget-nested"), gadgetDir, {
      recursive: true,
    });
    const resolved = await resolvePackageConfig(
      { target },
      { packages: [] },
      ws.root
    );
    expect(resolved.detected.skip).not.toBe(true);
  });
});

describe("resolveEntryForDetect", () => {
  it("defaults to .gadget/client", () => {
    expect(resolveEntryForDetect(undefined)).toBe(".gadget/client");
  });

  it("returns user paths when provided", () => {
    expect(resolveEntryForDetect(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("deepMerge", () => {
  it("later sources override earlier sources", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });
});
