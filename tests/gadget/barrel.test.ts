import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeBarrelPackage } from "../../src/barrel";
import {
  resolveAllPackageEntries,
  resolvePackageEntryAbs,
} from "../../src/detector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_FIXTURES = resolve(__dirname, "..", "fixtures", "packages");

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

  it("keeps a single-file barrel even when the entry source is not parseable", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "t", main: "index.js" })
    );
    // Minified CJS that confuses the parser; the analyzer must keep the entry
    // (refusing to prune is safer than failing the whole package).
    writeFileSync(join(root, "index.js"), "export {{{");
    const result = await analyzeBarrelPackage(
      root,
      { name: "t", main: "index.js" },
      new Set(),
      new Set()
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keepRelPaths.has("index.js")).toBe(true);
      expect(result.keepRelPaths.has("package.json")).toBe(true);
    }
  });

  it("skips unparseable dist-esm/Client.js package entries without failing", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    mkdirSync(join(root, "dist-esm", "models"), { recursive: true });
    writeFileSync(
      join(root, "dist-esm", "models", "ShopifyProduct.js"),
      "export const ShopifyProduct = 1;"
    );
    writeFileSync(
      join(root, "dist-esm", "models", "Unused.js"),
      "export const Unused = 1;"
    );
    writeFileSync(
      join(root, "dist-esm", "index.js"),
      `export { ShopifyProduct } from "./models/ShopifyProduct.js";
export { Unused } from "./models/Unused.js";`
    );
    writeFileSync(join(root, "dist-esm", "Client.js"), "export class Client {{{");
    const pkgJson = {
      name: "t",
      main: "./dist-esm/Client.js",
      module: "./dist-esm/index.js",
      exports: {
        ".": {
          import: "./dist-esm/index.js",
          default: "./dist-esm/Client.js",
        },
      },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(pkgJson));

    const result = await analyzeBarrelPackage(
      root,
      pkgJson,
      new Set(["shopifyProduct"]),
      new Set()
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keepRelPaths.has("dist-esm/Client.js")).toBe(true);
    expect(result.keepRelPaths.has("dist-esm/index.js")).toBe(true);
    expect(result.keepRelPaths.has("dist-esm/models/ShopifyProduct.js")).toBe(
      true
    );
    expect(result.keepRelPaths.has("dist-esm/models/Unused.js")).toBe(false);
  });

  it("keeps every resolved entry from a dual-bundle exports map", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    cpSync(join(PACKAGE_FIXTURES, "gadget-dual-bundle"), root, {
      recursive: true,
    });
    const pkgJson = JSON.parse(
      readFileSync(join(root, "package.json"), "utf-8"),
    ) as Record<string, unknown>;

    const resolved = await resolveAllPackageEntries(root, pkgJson);
    const relResolved = resolved.map((p) =>
      p.replace(root, "").replace(/^\/+/, ""),
    );
    expect(relResolved).toEqual(
      expect.arrayContaining([
        "dist-esm/index.js",
        "dist-cjs/index.js",
        "types-esm/index.d.ts",
        "types/index.d.ts",
      ]),
    );

    const result = await analyzeBarrelPackage(
      root,
      pkgJson,
      new Set(["customer"]),
      new Set(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Each entry file must survive — the ESM and CJS runtime bundles plus the
    // standalone TS declarations bundlers and type-checkers depend on.
    expect(result.keepRelPaths.has("dist-esm/index.js")).toBe(true);
    expect(result.keepRelPaths.has("dist-cjs/index.js")).toBe(true);
    expect(result.keepRelPaths.has("types-esm/index.d.ts")).toBe(true);
    expect(result.keepRelPaths.has("types/index.d.ts")).toBe(true);
    expect(result.keepRelPaths.has("package.json")).toBe(true);

    // Allowed member files reachable from any entry stay; unrelated ones do not.
    expect(result.keepRelPaths.has("dist-esm/internal/Customer.js")).toBe(true);
    expect(result.keepRelPaths.has("dist-esm/internal/Product.js")).toBe(false);
  });

  it("ignores entry candidates that don't resolve on disk", async () => {
    root = mkdtempSync(join(tmpdir(), "pkg-opt-barrel-"));
    mkdirSync(join(root, "dist-esm"));
    writeFileSync(join(root, "dist-esm", "index.js"), "export const used = 1;");
    const pkgJson = {
      name: "partial",
      exports: {
        ".": {
          import: "./dist-esm/index.js",
          require: "./dist-cjs/index.js",
        },
      },
    };
    writeFileSync(join(root, "package.json"), JSON.stringify(pkgJson));

    const resolved = await resolveAllPackageEntries(root, pkgJson);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatch(/dist-esm[\\/]+index\.js$/);

    const result = await analyzeBarrelPackage(
      root,
      pkgJson,
      new Set(["used"]),
      new Set(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keepRelPaths.has("dist-esm/index.js")).toBe(true);
    }
  });
});
