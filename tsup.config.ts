import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
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
    onSuccess: async () => {
      const src = resolve("src/presets");
      const dest = resolve("dist/presets");
      try {
        await stat(src);
      } catch {
        return;
      }
      await mkdir(dest, { recursive: true });
      const names = await readdir(src);
      await Promise.all(
        names.reduce<Promise<void>[]>((acc, name) => {
          if (!name.endsWith(".json")) return acc;
          acc.push(copyFile(resolve(src, name), resolve(dest, name)));
          return acc;
        }, [])
      );
    },
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
