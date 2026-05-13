import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgVersion = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(import.meta.url), "..", "package.json"),
    "utf8"
  )
).version as string;

const versionDefine = {
  "process.env.PKG_OPTIMIZE_VERSION": JSON.stringify(pkgVersion),
} as const;

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    platform: "node",
    define: versionDefine,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    clean: false,
    target: "node22",
    platform: "node",
    sourcemap: true,
    define: versionDefine,
  },
]);
