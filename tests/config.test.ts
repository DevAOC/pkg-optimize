import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyTopLevelDefaults,
  findConfig,
  loadConfig,
  validate,
} from "../src/config";
import { createWorkspace, type Workspace } from "./helpers";

describe("config", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("finds config by walking up from a nested cwd", async () => {
    const configPath = resolve(ws.root, "pkg-optimize.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ packages: [{ target: "a" }] })
    );
    const nested = resolve(ws.root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(await findConfig(nested)).toBe(configPath);
  });

  it("throws clearly on missing packages field", () => {
    expect(() => validate({})).toThrow(/packages/);
  });

  it("throws clearly on invalid config shape", () => {
    expect(() =>
      validate({
        packages: [{ target: "x", allow: { include: "not-array" } }],
      })
    ).toThrow();
  });

  it("applies top-level scanDirs to packages that do not define their own", async () => {
    const cfg = await applyTopLevelDefaults(
      {
        scanDirs: ["web"],
        packages: [
          { target: "a" },
          { target: "b", scanDirs: ["extensions"] },
        ],
      },
      ws.root
    );
    expect(cfg.packages[0].scanDirs).toEqual(["web"]);
    expect(cfg.packages[1].scanDirs).toEqual(["extensions"]);
  });

  it("returns a zero-config when no config file exists", async () => {
    const { config, configPath } = await loadConfig(ws.root);
    expect(config.packages).toEqual([]);
    expect(configPath).toBe(resolve(ws.root, "pkg-optimize.config.json"));
  });

  it("parses a valid config file from disk", async () => {
    const configPath = ws.writeConfig({
      scanDirs: ["web"],
      packages: [
        {
          target: "@gadget-client/my-app",
          allow: { include: ["authSession"] },
        },
      ],
    });
    const { config } = await loadConfig(ws.root);
    expect(config.packages.length).toBe(1);
    expect(config.packages[0].target).toBe("@gadget-client/my-app");
    expect(configPath).toBe(resolve(ws.root, "pkg-optimize.config.json"));
  });

  it("normalizes legacy targetPackage to target", () => {
    const config = validate({
      packages: [{ targetPackage: "@gadget-client/legacy" }],
    });
    expect(config.packages[0].target).toBe("@gadget-client/legacy");
  });

  it("accepts optional entry on packages", () => {
    expect(() =>
      validate({
        packages: [{ target: "x", entry: "../../vendor/pkg" }],
      })
    ).not.toThrow();
  });

  it("accepts optional entry as string or path list on packages", () => {
    expect(() =>
      validate({
        packages: [
          {
            target: "x",
            entry: ["generated/client", ".cache/sdk"],
          },
        ],
      })
    ).not.toThrow();
  });

  it("rejects patterns in config (hardcoded in the tool)", () => {
    expect(() =>
      validate({
        packages: [
          {
            target: "@gadget-client/x",
            patterns: { namespace: "api" },
          },
        ],
      })
    ).toThrow();
  });

  it("detects scan dirs from filesystem when none configured", async () => {
    mkdirSync(resolve(ws.root, "web"));
    mkdirSync(resolve(ws.root, "src"));
    ws.writeConfig({ packages: [{ target: "a" }] });
    const { config } = await loadConfig(ws.root);
    expect(config.scanDirs).toContain("web");
    expect(config.scanDirs).toContain("src");
  });
});
