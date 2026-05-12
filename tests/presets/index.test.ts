import { describe, expect, it } from "vitest";
import { listPresetNames, loadPreset } from "../../src/presets/index";
import type { ArgStyle } from "../../src/types";

const VALID_ARG_STYLES = new Set<ArgStyle>([
  "namespace-member",
  "namespace-member-member",
  "string",
  "imported-identifier",
  "object-property-identifier",
  "object-property-string",
]);

const VALID_LAYOUTS = new Set(["flat", "nested", "destructure", "barrel"]);
const VALID_NAMING = new Set([
  "PascalCase",
  "camelCase",
  "kebab-case",
  "snake_case",
]);

describe("presets", () => {
  it("exposes a non-empty canonical preset list", () => {
    const names = listPresetNames();
    expect(names.length).toBeGreaterThanOrEqual(11);
    for (const name of names) {
      expect(name.startsWith("pkg-optimize/presets/")).toBe(true);
    }
  });

  for (const name of listPresetNames()) {
    describe(name, () => {
      const preset = loadPreset(name);

      it("loads", () => {
        expect(preset).not.toBeNull();
        expect(preset?.patterns).toBeDefined();
        expect(preset?.packageStructure).toBeDefined();
      });

      it("uses only known argStyles and includes objectProperty when needed", () => {
        for (const hook of preset?.patterns?.hooks ?? []) {
          expect(VALID_ARG_STYLES.has(hook.argStyle)).toBe(true);
          if (
            hook.argStyle === "object-property-identifier" ||
            hook.argStyle === "object-property-string"
          ) {
            expect(typeof hook.objectProperty).toBe("string");
            expect(hook.objectProperty!.length).toBeGreaterThan(0);
          }
          expect(typeof hook.argIndex).toBe("number");
          expect(hook.argIndex).toBeGreaterThanOrEqual(0);
          expect(/^[a-zA-Z_$][\w$]*$/.test(hook.name)).toBe(true);
        }
      });

      it("uses a known layout and naming convention", () => {
        const ps = preset?.packageStructure;
        expect(ps?.layout).toBeDefined();
        expect(VALID_LAYOUTS.has(ps!.layout!)).toBe(true);
        expect(VALID_NAMING.has(ps!.naming!)).toBe(true);
      });
    });
  }
});
