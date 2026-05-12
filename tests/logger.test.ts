import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureLogging,
  dbg,
  emitResult,
  formatResultLine,
  logVerboseRunSummary,
  primeErrorDebug,
} from "../src/logger";
import type { PruneResult } from "../src/types";

const ORIGINAL_DEBUG = process.env.DEBUG;

afterEach(() => {
  if (ORIGINAL_DEBUG === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = ORIGINAL_DEBUG;
});

describe("formatResultLine", () => {
  it("includes package name, kept, removed, restored when present", () => {
    const r: PruneResult = {
      packageName: "a",
      removed: ["x"],
      restored: ["y"],
      kept: ["z", "w"],
      warnings: [],
    };
    expect(formatResultLine(r)).toBe("a · kept 2 · removed 1 · restored 1");
  });

  it("omits removed/restored when empty", () => {
    const r: PruneResult = {
      packageName: "pkg",
      removed: [],
      restored: [],
      kept: [],
      warnings: [],
    };
    expect(formatResultLine(r)).toBe("pkg · kept 0");
  });
});

describe("primeErrorDebug", () => {
  it("appends pkg-optimize:error when DEBUG is empty", () => {
    delete process.env.DEBUG;
    primeErrorDebug();
    expect(process.env.DEBUG).toContain("pkg-optimize:error");
  });

  it("does not duplicate when pkg-optimize:error already set", () => {
    process.env.DEBUG = "pkg-optimize:error";
    primeErrorDebug();
    expect(process.env.DEBUG).toBe("pkg-optimize:error");
  });

  it("leaves DEBUG unchanged when pkg-optimize wildcard already enabled", () => {
    process.env.DEBUG = "pkg-optimize:*,other:trace";
    primeErrorDebug();
    expect(process.env.DEBUG).toContain("pkg-optimize:*");
    expect(process.env.DEBUG).toContain("other:trace");
  });
});

describe("configureLogging", () => {
  it("preserves non-pkg-optimize DEBUG channels", () => {
    process.env.DEBUG = "foo:bar,pkg-optimize:warn";
    configureLogging({});
    expect(process.env.DEBUG).toContain("foo:bar");
    expect(process.env.DEBUG).toContain("pkg-optimize:error");
    expect(process.env.DEBUG).toContain("pkg-optimize:warn");
  });

  it("--silent keeps only pkg-optimize:error among pkg channels", () => {
    process.env.DEBUG = "pkg-optimize:*,other:x";
    configureLogging({ silent: true });
    expect(process.env.DEBUG).toContain("other:x");
    expect(process.env.DEBUG).toContain("pkg-optimize:error");
    expect(process.env.DEBUG).not.toContain("pkg-optimize:*");
  });

  it("--verbose sets pkg-optimize:* while preserving others", () => {
    process.env.DEBUG = "alpha:1";
    configureLogging({ verbose: true });
    expect(process.env.DEBUG).toContain("alpha:1");
    expect(process.env.DEBUG).toContain("pkg-optimize:*");
  });
});

describe("emitResult", () => {
  it("logs formatted line and warnings via debug channels", () => {
    const resultSpy = vi.spyOn(dbg, "result").mockImplementation(() => {});
    const warnSpy = vi.spyOn(dbg, "warn").mockImplementation(() => {});
    emitResult({
      packageName: "pkg",
      removed: [],
      restored: [],
      kept: ["a"],
      warnings: ["look out"],
    });
    expect(resultSpy).toHaveBeenCalledWith("pkg · kept 1");
    expect(warnSpy).toHaveBeenCalled();
    resultSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("logVerboseRunSummary", () => {
  it("does not throw for empty or non-empty results", () => {
    expect(() => logVerboseRunSummary([])).not.toThrow();
    expect(() =>
      logVerboseRunSummary([
        {
          packageName: "p",
          removed: [],
          restored: [],
          kept: [],
          warnings: ["w"],
        },
      ]),
    ).not.toThrow();
  });
});
