import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliReal = join(root, "dist", "cli.js");

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
