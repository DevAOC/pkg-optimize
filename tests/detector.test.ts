import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPackageConfig } from "../src/detector";
import { createWorkspace, FIXTURE_PATHS, type Workspace } from "./helpers";

describe("detector", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("skips non-gadget targets", async () => {
    const detected = await detectPackageConfig("lodash-es", ws.root);
    expect(detected.skip).toBe(true);
  });

  it("resolves a fixture in node_modules", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    const detected = await detectPackageConfig(
      "@gadget-client/test-app",
      ws.root
    );
    expect(detected.confidence).toBe("high");
    expect(detected.skip).not.toBe(true);
  });

  it("resolves symlink-hoisted installs", async () => {
    ws.installFixturePackageSymlinked(
      "gadget-nested",
      "@gadget-client/test-app"
    );
    const detected = await detectPackageConfig(
      "@gadget-client/test-app",
      ws.root
    );
    expect(detected.skip).not.toBe(true);
  });

  it("resolves dist-esm fixture via .gadget/client entry", async () => {
    const target = "@gadget-client/dist-app";
    const gadgetDir = resolve(ws.root, ".gadget", "client");
    mkdirSync(gadgetDir, { recursive: true });
    cpSync(resolve(FIXTURE_PATHS.packages, "gadget-dist-esm"), gadgetDir, {
      recursive: true,
    });
    const detected = await detectPackageConfig(target, ws.root, {
      entry: [".gadget/client"],
    });
    expect(detected.skip).not.toBe(true);
  });

  it("resolves via entry when node_modules entry is broken", async () => {
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
    const detected = await detectPackageConfig(target, ws.root, {
      entry: [".gadget/client"],
    });
    expect(detected.skip).not.toBe(true);
  });

  it("sets skip when package entry cannot be resolved", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/broken");
    const pkgDir = resolve(ws.root, "node_modules", "@gadget-client/broken");
    writeFileSync(
      resolve(pkgDir, "package.json"),
      JSON.stringify({
        name: "@gadget-client/broken",
        main: "this-file-does-not-exist.js",
      })
    );
    const detected = await detectPackageConfig("@gadget-client/broken", ws.root);
    expect(detected.skip).toBe(true);
  });
});
