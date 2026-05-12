import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeBarrelPackage } from "../../../src/layouts/barrel/graph";
import { resolvePackageEntryAbs } from "../../../src/detector";

describe("resolvePackageEntryAbs", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("resolves main field", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", main: "./entry.js" })
    );
    writeFileSync(join(root, "entry.js"), "export {};");
    await expect(
      resolvePackageEntryAbs(root, { main: "./entry.js" })
    ).resolves.toBe(join(root, "entry.js"));
  });

  it('resolves exports["."] string', async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", exports: { ".": "./out.js" } })
    );
    writeFileSync(join(root, "out.js"), "export {};");
    await expect(
      resolvePackageEntryAbs(root, { exports: { ".": "./out.js" } })
    ).resolves.toBe(join(root, "out.js"));
  });

  it('resolves exports["."].import over default', async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(join(root, "esm.mjs"), "export {};");
    const pkgJson = {
      exports: { ".": { import: "./esm.mjs", default: "./missing.cjs" } },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(pkgJson));
    await expect(resolvePackageEntryAbs(root, pkgJson)).resolves.toBe(
      join(root, "esm.mjs")
    );
  });

  it('falls back to exports["."].default when import missing', async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(join(root, "d.cjs"), "module.exports = {};");
    const pkgJson = {
      exports: { ".": { default: "./d.cjs" } },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(pkgJson));
    await expect(resolvePackageEntryAbs(root, pkgJson)).resolves.toBe(
      join(root, "d.cjs")
    );
  });

  it("uses module when main absent", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(join(root, "mod.js"), "export {};");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", module: "./mod.js" })
    );
    await expect(
      resolvePackageEntryAbs(root, { module: "./mod.js" })
    ).resolves.toBe(join(root, "mod.js"));
  });

  it("defaults to index.js when no entry fields", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(join(root, "index.js"), "export {};");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "t" }));
    await expect(resolvePackageEntryAbs(root, { name: "t" })).resolves.toBe(
      join(root, "index.js")
    );
  });

  it('falls back to exports["."].types when import is missing', async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(join(root, "api.d.ts"), "export const api: unknown;");
    const pkgJson = {
      exports: {
        ".": {
          import: "./missing.js",
          types: "./api.d.ts",
        },
      },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(pkgJson));
    await expect(resolvePackageEntryAbs(root, pkgJson)).resolves.toBe(
      join(root, "api.d.ts"),
    );
  });

  it("returns null when entry file is missing", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", main: "./nope.js" })
    );
    await expect(
      resolvePackageEntryAbs(root, { main: "./nope.js" })
    ).resolves.toBeNull();
  });
});

describe("analyzeBarrelPackage", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns ok with keep set for a minimal single-file barrel", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", main: "index.js" })
    );
    writeFileSync(
      join(root, "index.js"),
      `export const used = 1;\nexport const drop = 2;\n`
    );
    const result = await analyzeBarrelPackage(
      root,
      { name: "t", main: "index.js" },
      new Set(["used"]),
      new Set()
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keepRelPaths.has("index.js")).toBe(true);
      expect(result.keepRelPaths.has("package.json")).toBe(true);
    }
  });

  it("fails when package entry cannot be resolved", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", main: "./missing.js" })
    );
    const result = await analyzeBarrelPackage(
      root,
      { name: "t", main: "./missing.js" },
      new Set(),
      new Set()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/resolve package entry/i);
    }
  });

  it("fails when entry source is not parseable", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", main: "index.js" })
    );
    writeFileSync(join(root, "index.js"), "export {{{");
    const result = await analyzeBarrelPackage(
      root,
      { name: "t", main: "index.js" },
      new Set(),
      new Set()
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/parse/i);
    }
  });
});
