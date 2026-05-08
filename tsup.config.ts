import { defineConfig } from 'tsup';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node22',
    platform: 'node',
    onSuccess: async () => {
      const src = resolve('src/presets');
      const dest = resolve('dist/presets');
      if (!existsSync(src)) return;
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(src)) {
        if (name.endsWith('.json')) {
          copyFileSync(resolve(src, name), resolve(dest, name));
        }
      }
    },
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    clean: false,
    target: 'node22',
    platform: 'node',
    sourcemap: true,
  },
]);
