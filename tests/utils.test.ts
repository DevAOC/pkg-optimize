import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAbortError,
  isDirectory,
  isFile,
  pathExists,
  withSignal,
} from "../src/utils";

describe("isAbortError", () => {
  it("returns true for DOMException-style AbortError", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("returns true for error object with name AbortError", () => {
    const e = new Error("x");
    e.name = "AbortError";
    expect(isAbortError(e)).toBe(true);
  });

  it("returns false for other errors and non-objects", () => {
    expect(isAbortError(new Error("no"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

describe("withSignal", () => {
  it("returns fn result when no signal", async () => {
    await expect(withSignal(undefined, async () => 42)).resolves.toBe(42);
  });

  it("throws immediately when already aborted", async () => {
    const signal = AbortSignal.abort();
    await expect(withSignal(signal, async () => 1)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rethrows AbortError after fn when aborted during await", async () => {
    const ac = new AbortController();
    const p = withSignal(ac.signal, async () => {
      await new Promise<void>((r) => queueMicrotask(r));
      ac.abort();
      return "done";
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("pathExists / isDirectory / isFile", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("pathExists returns false for missing paths without throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "pkg-opt-utils-"));
    await expect(pathExists(join(dir, "nope"))).resolves.toBe(false);
  });

  it("pathExists propagates abort before stat", async () => {
    await expect(
      pathExists(join(tmpdir(), "nope"), AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("isDirectory and isFile classify correctly", async () => {
    dir = mkdtempSync(join(tmpdir(), "pkg-opt-utils-"));
    const sub = join(dir, "sub");
    const f = join(dir, "f.txt");
    mkdirSync(sub);
    writeFileSync(f, "x");
    await expect(isDirectory(sub)).resolves.toBe(true);
    await expect(isDirectory(f)).resolves.toBe(false);
    await expect(isFile(f)).resolves.toBe(true);
    await expect(isFile(sub)).resolves.toBe(false);
  });

  it("isDirectory returns false for missing path", async () => {
    dir = mkdtempSync(join(tmpdir(), "pkg-opt-utils-"));
    await expect(isDirectory(join(dir, "missing"))).resolves.toBe(false);
  });
});
