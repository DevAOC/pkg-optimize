import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { createWorkspace, type Workspace } from "./helpers";

describe("runCli", () => {
  let ws: Workspace;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ws = createWorkspace();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    ws.cleanup();
  });

  it("returns 0 for --help", async () => {
    expect(await runCli({ argv: ["--help"], cwd: ws.root })).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  it("returns 0 for help positional", async () => {
    expect(await runCli({ argv: ["help"], cwd: ws.root })).toBe(0);
  });

  it("returns 0 and prints version for --version", async () => {
    const prev = process.env.PKG_OPTIMIZE_VERSION;
    process.env.PKG_OPTIMIZE_VERSION = "9.9.9";
    try {
      expect(await runCli({ argv: ["--version"], cwd: ws.root })).toBe(0);
      expect(logSpy.mock.calls.some((c) => c[0] === "9.9.9")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PKG_OPTIMIZE_VERSION;
      else process.env.PKG_OPTIMIZE_VERSION = prev;
    }
  });

  it("returns 1 and prints help for unknown flags (strict parseArgs)", async () => {
    expect(await runCli({ argv: ["--not-a-real-flag"], cwd: ws.root })).toBe(1);
    expect(logSpy).toHaveBeenCalled();
  });

  it("returns 1 for unknown command", async () => {
    expect(await runCli({ argv: ["frobnicate"], cwd: ws.root })).toBe(1);
  });

  it("returns 0 when no packages are configured", async () => {
    expect(await runCli({ argv: [], cwd: ws.root })).toBe(0);
  });

  it("returns 1 when config JSON is invalid", async () => {
    writeFileSync(resolve(ws.root, "pkg-optimize.config.json"), "{");
    await expect(runCli({ argv: [], cwd: ws.root })).resolves.toBe(1);
  });

  it("returns 0 with warnings when package is not installed", async () => {
    writeFileSync(
      resolve(ws.root, "pkg-optimize.config.json"),
      JSON.stringify({
        scanDirs: ["web"],
        packages: [{ targetPackage: "@scope/not-installed" }],
      })
    );
    expect(await runCli({ argv: ["run"], cwd: ws.root })).toBe(0);
  });

  it("returns 130 when run is aborted before processing", async () => {
    writeFileSync(
      resolve(ws.root, "pkg-optimize.config.json"),
      JSON.stringify({
        scanDirs: ["web"],
        packages: [{ targetPackage: "any" }],
      })
    );
    const code = await runCli({
      argv: ["run"],
      cwd: ws.root,
      signal: AbortSignal.abort(),
    });
    expect(code).toBe(130);
  });

  it("runs a full prune successfully for a configured workspace", async () => {
    ws.installFixturePackage("gadget-nested", "@example/test-app");
    ws.installFixtureSource({ dirs: ["web"] });
    ws.writeConfig({
      scanDirs: ["web"],
      packages: [{ targetPackage: "@example/test-app" }],
    });
    expect(await runCli({ argv: [], cwd: ws.root })).toBe(0);
  });

  it("persists _detected into config after first successful run", async () => {
    ws.installFixturePackage("gadget-nested", "@example/test-app");
    ws.installFixtureSource({ dirs: ["web"] });
    ws.writeConfig({
      scanDirs: ["web"],
      packages: [{ targetPackage: "@example/test-app" }],
    });
    expect(await runCli({ argv: ["run"], cwd: ws.root })).toBe(0);
    const raw = readFileSync(
      resolve(ws.root, "pkg-optimize.config.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      packages: Array<{ _detected?: unknown }>;
    };
    expect(parsed.packages[0]?._detected).toBeDefined();
  });

  it("watch mode stops cleanly when signal is aborted", async () => {
    ws.installFixturePackage("gadget-nested", "@example/test-app");
    ws.installFixtureSource({ dirs: ["web"] });
    ws.writeConfig({
      scanDirs: ["web"],
      packages: [{ targetPackage: "@example/test-app" }],
    });
    const ac = new AbortController();
    const done = runCli({
      argv: ["watch"],
      cwd: ws.root,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await expect(done).resolves.toBe(0);
  });
});

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliReal = join(repoRoot, "dist", "cli.js");

describe.skipIf(!existsSync(cliReal))("CLI entry (built dist/cli.js)", () => {
  it("runs when argv[1] is a symlink to dist/cli.js (npm .bin layout)", () => {
    const tmp = join(tmpdir(), `pkg-opt-cli-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmp);
    const fakeBin = join(tmp, "pkg-optimize");
    symlinkSync(cliReal, fakeBin);

    try {
      const out = execFileSync(process.execPath, [fakeBin, "--version"], {
        encoding: "utf8",
      });
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
