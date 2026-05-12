# pkg-optimize

Zero-config tree-shaker for **any npm package** whose files are independently importable. Scans your project for the symbols you actually reference, then prunes everything else from one or more target packages in `node_modules`. Framework- and platform-agnostic — works equally well against generated SDK clients, GraphQL/OpenAPI/RPC codegen output, and general-purpose libraries with file-per-export structure (`lodash-es`, `date-fns`, `react-icons`, `@radix-ui/*`, …).

- **Bidirectional pruning** — removes unused files _and_ restores them if they become needed again.
- **Multi-package aware** — runs across many target packages concurrently.
- **Auto-detection** — infers the package layout, naming convention, and access patterns. Most projects need only a few lines of config.
- **Watch mode** — re-prunes when source, packages, or config change.
- **Fifteen built-in presets** for common libraries and codegen tools.

> **Found a security issue?** Please report it privately — see [`SECURITY.md`](./SECURITY.md). Don't open a public issue or PR for vulnerability reports.

## What can it prune?

The scanner picks up usage from **all** of these patterns, so anything written in idiomatic JS/TS works:

| Pattern                                        | Source example                                   | What gets recorded                                   |
| ---------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| Named import                                   | `import { format } from 'date-fns'`              | member `format`                                      |
| Aliased import                                 | `import { format as f } from 'date-fns'`         | member `format` (source name)                        |
| Default import + member access                 | `import _ from 'lodash'; _.debounce(...)`        | member `debounce`                                    |
| Namespace import + member access               | `import * as fs from 'date-fns'; fs.format(...)` | member `format`                                      |
| Deep import                                    | `import { x } from 'pkg/sub/foo'`                | file `sub/foo`                                       |
| Side-effect import                             | `import 'pkg/styles.css'`                        | file `styles`                                        |
| Dynamic import (string literal)                | `await import('pkg/sub')`                        | file `sub`                                           |
| Dynamic import (template prefix)               | `` await import(`pkg/icons/${name}`) ``          | file `icons` (entire `icons/` tree kept)             |
| Dynamic import (whole-package or unresolvable) | `await import('pkg')` or `import(somePathVar)`   | wildcard — pruning is **disabled** for this package  |
| CJS require (string)                           | `require('pkg/sub')`                             | file `sub`                                           |
| `require.resolve`                              | `require.resolve('pkg/sub')`                     | file `sub`                                           |
| Namespace member access (generated SDKs)       | `api.shopProduct.update(...)`                    | member `shopProduct`, operation `shopProduct.update` |
| Hook with imported document                    | `useQuery(GetUserDocument)`                      | member `GetUserDocument`                             |
| Hook with options object                       | `useQuery({ query: GetUserDocument })`           | member `GetUserDocument`                             |

That covers, in practice:

- Generated SDK clients (Gadget, Apollo, Relay, urql, tRPC, …)
- Codegen output (graphql-codegen, Orval, Kubb, …)
- Utility libraries with file-per-export structure (`lodash-es`, `date-fns`, …)
- Icon and component packages (`react-icons/*`, `@radix-ui/*`, …)
- Anything else where each file is independently importable

**Single-file barrels** (everything lives in one bundled `index.js` with no separate modules to delete) cannot be shrunk at file level. **Multi-file barrels** — an entry that re-exports from other files on disk — are traced, unused modules are removed, and pure barrel files are rewritten so they no longer point at deleted targets. If barrel analysis fails (unparseable entry, unsupported patterns), pruning is skipped with a warning.

### Dynamic imports are safe by construction

Dynamic imports are tracked the same way as static ones, with one extra guarantee: **if the scanner sees a dynamic reference it can't statically resolve to a specific subpath, it disables pruning for that package and restores any previously-removed files.** That includes:

- `await import('pkg')` with no subpath (returns the whole namespace object)
- `require('pkg')` (CJS, same reason)
- `` await import(`pkg/${variable}`) `` where the dynamic portion follows the package name

In those cases pkg-optimize emits a warning and keeps the package whole — it will never silently delete a file that a code-split chunk needs at runtime. Pruning resumes automatically once the dynamic reference is removed or replaced with a statically-resolvable form.

## Vocabulary

To stay neutral across frameworks, `pkg-optimize` uses two abstract terms:

| Term          | What it means                                                | Examples                                                                  |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **member**    | A top-level symbol attached to the package's root namespace. | `client.user` (member: `user`), `api.shopProduct` (member: `shopProduct`) |
| **operation** | A second-level symbol attached to a member.                  | `client.user.list` (operation: `user.list`), `api.shopProduct.update`     |

Whether your codegen tool calls them models/actions, queries/mutations, routers/procedures, or endpoints/methods — `pkg-optimize` always works in terms of `members` and `operations`.

## Requirements

- **Node.js 22 or newer** (Node 22 LTS or Node 24 LTS).

  Older Node versions are end-of-life and no longer receive security patches:

  - Node 18 has been EOL since April 30, 2025 and has multiple unpatched CVEs (HTTP/2 server crash, request smuggling, buffer-allocation race, etc.).
  - Node 20 reached EOL on April 30, 2026.

  We pin to the oldest supported LTS line and don't intend to chase the bleeding edge — but we won't ship to a Node version that the upstream project no longer patches.

## Installation

```bash
npm install -D pkg-optimize
# or
yarn add -D pkg-optimize
```

## Quick start

Create `pkg-optimize.config.json` at the root of your project:

```json
{
  "scanDirs": ["src"],
  "packages": [{ "targetPackage": "@example/generated-client" }]
}
```

Then add it to your `package.json` scripts:

```json
{
  "scripts": {
    "postinstall": "pkg-optimize run",
    "prebuild": "pkg-optimize run",
    "dev": "concurrently \"pkg-optimize watch\" \"vite\""
  }
}
```

That's it. On first run, `pkg-optimize` detects the package layout, scans your source for symbols you reference, and prunes the unused files from the target package. The pristine package is kept in `.pkg-optimize-cache/` so anything you add later is restored automatically.

Add `.pkg-optimize-cache/` to your `.gitignore`:

```
.pkg-optimize-cache/
```

## How it works

1. **Detect.** On first run the detector inspects your target package and infers `patterns` (how the package is referenced in source) and `packageStructure` (how it's organized on disk). The result is written back to your config under a `_detected` key so you can see what it inferred.
2. **Cache.** A pristine copy of the target package is stored in `.pkg-optimize-cache/`. The pruner always reads from there and writes to `node_modules/<targetPackage>` — never the other way around. This is what makes restores work.
3. **Scan.** AST-based scanner walks your source directories and builds a usage map of which members and operations are actually referenced.
4. **Diff.** The diff is bidirectional:
   - In live but not in usage → **remove**
   - In usage but missing from live → **restore from cache**
   - In both → keep
   - In neither → skip
5. **Repeat.** In `watch` mode, the same loop re-runs on a debounce when sources, the target package, or your config change.

## Using in CI

The CI flow is the same three steps as local: **install → prune → build**.

```yaml
# Adapt to your CI provider
- npm ci
- npx pkg-optimize run
- npm run build
```

That's it for most projects. The notes below cover ordering, caching, common providers, and failure modes.

### Where to invoke it

Three reasonable options, in order of "least magic last":

1. **`postinstall` script** — runs automatically after `npm ci`. No CI changes needed.
   ```json
   { "scripts": { "postinstall": "pkg-optimize run" } }
   ```
2. **`prebuild` script** — runs immediately before your bundler. Useful if you want to keep `npm install` itself unmodified.
   ```json
   { "scripts": { "prebuild": "pkg-optimize run" } }
   ```
3. **Explicit step** — `npx pkg-optimize run` in your CI workflow file. Most visible, least implicit behavior.

Pick whichever is most discoverable for your team. Don't combine them — one is enough.

### Cache strategy

`.pkg-optimize-cache/` holds the pristine copy of each target package and is what makes restores work.

- **Always `.gitignore` it.** It's regenerated from `node_modules` and can be large.
- **You don't need to do anything special in CI.** A fresh `npm ci` populates `node_modules` with the unpruned package; pkg-optimize primes the cache from there in a few hundred milliseconds and prunes the live copy. The cache always stays consistent with the freshly-installed `node_modules`.
- **Optional speed-up:** if you already cache `node_modules/` across CI runs, you can also cache `.pkg-optimize-cache/` — but it **must** share the same cache key as your lockfile (e.g., a hash of `package-lock.json`). Caching it independently risks a stale pristine copy that no longer matches the installed `node_modules`.

### GitHub Actions

```yaml
name: build
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "22.14"
          cache: "npm"
      - run: npm ci
      - run: npx pkg-optimize run
      - run: npm run build
```

If pkg-optimize is wired into `postinstall` or `prebuild`, drop the explicit step — it runs automatically.

### GitLab CI

```yaml
build:
  image: node:22
  cache:
    key:
      files:
        - package-lock.json
    paths:
      - .npm/
      - node_modules/
      - .pkg-optimize-cache/
  script:
    - npm ci --cache .npm --prefer-offline
    - npx pkg-optimize run
    - npm run build
```

The `key.files: [package-lock.json]` is what keeps `.pkg-optimize-cache/` in sync with `node_modules/`.

### Vercel / Netlify / Render / other PaaS builders

These run `npm install` then your `build` script from `package.json`. Add a `postinstall` or `prebuild` — no platform config needed:

```json
{
  "scripts": {
    "postinstall": "pkg-optimize run",
    "build": "vite build"
  }
}
```

### Monorepos

For workspace-style monorepos (npm/pnpm/yarn workspaces), the simplest setup is **one config per workspace** with a `prebuild` script in each `package.json`. Turborepo / Nx will pick it up automatically because it's just an npm script.

If you'd rather have a single root config covering multiple packages, list them under one `packages` array:

```json
{
  "scanDirs": ["apps/web/src", "apps/admin/src", "packages/ui/src"],
  "packages": [
    { "targetPackage": "@my-org/api-client" },
    { "targetPackage": "@my-org/icons" },
    {
      "targetPackage": "lodash-es",
      "scanDirs": ["apps/web/src", "apps/admin/src"]
    }
  ]
}
```

Per-package `scanDirs` overrides the top-level value — handy when only some workspaces consume a given package.

### Failure modes

pkg-optimize is designed to fail safe in CI:

- A package it can't analyze — **barrel** layout where static re-export analysis fails, missing in `node_modules`, unreadable, etc. — is **skipped with a warning** and the exit code stays `0`. Your build still runs against the unpruned package.
- A package referenced by an unresolvable dynamic import (`await import(somePath)`, `await import('pkg')` with no subpath, etc.) is **kept whole**. The scanner detects the dynamic reference, the pruner switches to restore-only mode, and a warning is emitted. Code-split chunks never break at runtime because the file they import was deleted.
- A malformed `pkg-optimize.config.json` exits non-zero immediately so a bad config never silently breaks builds.
- The cache is **never** mutated based on usage; only `node_modules/<targetPackage>/` is. If anything ever goes wrong, `rm -rf node_modules .pkg-optimize-cache && npm ci` rebuilds the world.

### Pairing with bundle-size checks

Because pruning happens at the file level _before_ your bundler sees the package, tools like `size-limit`, `webpack-bundle-analyzer`, or Next.js's `--analyze` mode work normally and reflect the post-prune size:

```yaml
- run: npm ci
- run: npx pkg-optimize run
- run: npm run build
- run: npx size-limit
```

If a contributor accidentally bypasses pkg-optimize, the bundle grows and `size-limit` catches the regression.

### Skipping pruning in dev

If you want full intellisense and the original package contents on developer machines (and only prune in CI), keep the explicit step out of `package.json` and call `pkg-optimize run` only from your CI workflow. Or use the inverse — have CI set `PKG_OPTIMIZE=1` and gate your `postinstall` on it:

```json
{
  "scripts": {
    "postinstall": "[ \"$PKG_OPTIMIZE\" = '1' ] && pkg-optimize run || true"
  }
}
```

(The exact shell incantation depends on your environment; the principle is "make it conditional on a variable your CI sets".)

## CLI

```
pkg-optimize [run|watch] [options]

Commands:
  run               One-shot prune. (default)
  watch             Watch sources, target packages, and config.

Options:
  --verbose         Verbose diagnostics (`DEBUG=pkg-optimize:*`).
  --silent          Only `pkg-optimize:error` debug output.
  --help, -h        Show help.
  --version, -v     Show version.
```

## Configuration

### Minimal

```json
{
  "scanDirs": ["src"],
  "packages": [{ "targetPackage": "@example/generated-client" }]
}
```

### Multi-package

```json
{
  "scanDirs": ["src", "extensions"],
  "packages": [
    { "targetPackage": "@example/generated-client" },
    {
      "targetPackage": "@example/analytics-client",
      "scanDirs": ["src/analytics"]
    }
  ]
}
```

### Full reference

```json
{
  "scanDirs": ["src"],
  "cache": { "dir": ".pkg-optimize-cache" },
  "watch": {
    "debounceMs": 300,
    "softPruneInDev": true
  },
  "packages": [
    {
      "targetPackage": "@example/generated-client",
      "extends": "pkg-optimize/presets/urql",
      "scanDirs": ["src"],
      "allow": {
        "include": ["session", "user.create"]
      },
      "patterns": {
        "namespace": "client",
        "accessStyle": "member",
        "depth": { "member": 1, "operation": 2 },
        "hooks": [
          {
            "name": "useQuery",
            "argIndex": 0,
            "argStyle": "object-property-identifier",
            "objectProperty": "query"
          },
          {
            "name": "useMutation",
            "argIndex": 0,
            "argStyle": "imported-identifier"
          }
        ]
      },
      "packageStructure": {
        "layout": "flat",
        "memberDir": "operations",
        "naming": "PascalCase",
        "extensions": [".js", ".d.ts"],
        "preserve": [
          "index.js",
          "index.d.ts",
          "types.js",
          "types.d.ts",
          "package.json"
        ]
      }
    }
  ]
}
```

### Field reference

| Field                             | Type                                                          | Notes                                                           |
| --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| `patterns.namespace`              | string                                                        | Root identifier (`client`, `api`, `trpc`, `graphql`, …).        |
| `patterns.accessStyle`            | `"member" \| "destructure"`                                   | Currently only `"member"` is implemented.                       |
| `patterns.depth.member`           | number                                                        | Doc-only; depth at which member references appear.              |
| `patterns.depth.operation`        | number                                                        | Doc-only; depth at which operation references appear.           |
| `patterns.hooks[].name`           | string                                                        | Function-call name to look for.                                 |
| `patterns.hooks[].argIndex`       | number                                                        | Which argument carries the symbol reference.                    |
| `patterns.hooks[].argStyle`       | enum (see below)                                              | How the argument encodes the symbol.                            |
| `patterns.hooks[].objectProperty` | string                                                        | Required for the `object-property-*` styles.                    |
| `packageStructure.layout`         | `"flat" \| "nested" \| "destructure" \| "barrel"`             | How files are organised on disk (see _Layouts_ below).          |
| `packageStructure.memberDir`      | string                                                        | Directory holding one file (or subdir) per member.              |
| `packageStructure.operationDir`   | string                                                        | Optional separate dir for operations (flat layout only).        |
| `packageStructure.naming`         | `"PascalCase" \| "camelCase" \| "kebab-case" \| "snake_case"` | Filename convention for case normalization.                     |
| `packageStructure.extensions`     | string[]                                                      | File extensions the pruner is allowed to remove (multi-dot OK). |
| `packageStructure.preserve`       | string[]                                                      | Files that must never be removed regardless of usage.           |

### Layouts

| Layout        | Shape                                                                                                                                                                 | Examples                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `flat`        | One file per member inside `memberDir` (e.g. `models/Foo.js`).                                                                                                        | Apollo codegen, tRPC, Orval                             |
| `nested`      | One subdir per member inside `memberDir`, with optional sub-files for operations.                                                                                     | Gadget                                                  |
| `destructure` | Each top-level entry of `memberDir` (or the package root) is itself a member — file _or_ dir.                                                                         | `lodash-es`, `date-fns`, `react-icons/*`, `@radix-ui/*` |
| `barrel`      | Entry re-exports from other files; pruner traces `export … from` / `export * from`, deletes unused modules, rewrites barrel files. Single-file bundles are unchanged. | internal libs, some SDKs                                |

### Merge priority (highest to lowest)

1. Explicit user config fields
2. Auto-detected values
3. Preset values (from `extends` or auto-matched on package name)
4. Built-in defaults

## Restoring a removed symbol

If something was pruned and you need it back, add it to `allow.include`:

```json
{
  "allow": {
    "include": [
      "user", // member
      "user.create", // operation on a member
      "icons/User", // explicit file path (anything containing `/`)
      "locale/en-US/index" // explicit file path
    ]
  }
}
```

Then run `pkg-optimize run` (or save any file in watch mode) and the pruner will copy the file back from cache.

You can also nuke the live package and reinstall:

```bash
rm -rf node_modules/@example/generated-client && yarn install
```

The `postinstall` script will repopulate it from cache.

## Presets

Fifteen built-in presets ship out of the box. They are auto-applied based on the target package name and you can also extend any of them explicitly via `"extends": "pkg-optimize/presets/<name>"`.

### Codegen / SDK presets (member or hook-driven)

| Preset            | Auto-matches                                 | Notes                                                                                       |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `gadget`          | `@gadget-client/*`                           | Nested layout, `useFindMany` / `useAction` family.                                          |
| `apollo`          | `@apollo/*`                                  | `useQuery` / `useMutation` accept either an imported document or a string.                  |
| `trpc`            | `@trpc/*`                                    | Member-style chained access (`trpc.user.list`).                                             |
| `urql`            | `urql`, `@urql/*`                            | `useQuery({ query: Doc })`, `useMutation(Doc)`, `useSubscription`.                          |
| `relay`           | `react-relay`, `@relay/*`                    | `useFragment` / `useLazyLoadQuery` / `usePreloadedQuery` over `__generated__/*.graphql.ts`. |
| `react-query`     | `@tanstack/react-query`, `@tanstack/query-*` | `useQuery({ queryFn })`, `useMutation({ mutationFn })`, etc.                                |
| `swr`             | `swr`                                        | `useSWR(key, fetcher)`, `useSWRMutation`, `useSWRInfinite`.                                 |
| `graphql-request` | `graphql-request`                            | `request(url, Doc)` — function-style, not a hook.                                           |
| `graphql-codegen` | `@graphql-codegen/*`                         | Generic GraphQL document import patterns.                                                   |
| `orval`           | `orval`, `@orval/*`                          | OpenAPI codegen with kebab-case endpoints + react-query hooks.                              |
| `kubb`            | `@kubb/*`                                    | OpenAPI/GraphQL codegen with nested PascalCase hook layout.                                 |

### General-purpose library presets (import-driven, destructure layout)

| Preset        | Auto-matches                   | Notes                                               |
| ------------- | ------------------------------ | --------------------------------------------------- |
| `lodash-es`   | `lodash-es`                    | One file per export at the package root, camelCase. |
| `date-fns`    | `date-fns`                     | Mixed file/dir layout, camelCase.                   |
| `react-icons` | `react-icons`, `react-icons/*` | One file per icon, PascalCase.                      |
| `radix`       | `@radix-ui/*`                  | One file per component, PascalCase.                 |

The codegen presets describe **how a framework's hooks reference generated symbols**; your `targetPackage` is still the generated client (e.g. `./src/generated/graphql`). React, Preact, and other UI frameworks themselves don't ship a preset because their built-in hooks (`useState`, `useEffect`, …) don't reference any generated symbols.

The general-purpose presets target popular destructure-style libraries directly. You can use them as-is or as templates for your own packages.

Explicit usage:

```json
{
  "packages": [
    {
      "targetPackage": "./src/generated/graphql",
      "extends": "pkg-optimize/presets/urql"
    }
  ]
}
```

### Pruning a general-purpose package

Same shape — just point at the package and let the destructure preset (or auto-detection) do the rest:

```json
{
  "scanDirs": ["src"],
  "packages": [
    { "targetPackage": "lodash-es" },
    { "targetPackage": "date-fns" },
    { "targetPackage": "react-icons/fa" },
    { "targetPackage": "@radix-ui/react-dialog" }
  ]
}
```

After one run, only the files you actually `import` survive in `node_modules`; the rest are kept safe in `.pkg-optimize-cache/` and restored automatically the moment you import them again.

### Hook argument styles

The scanner understands six ways a function call can encode the symbol it depends on:

| `argStyle`                   | Example                               | What gets recorded                     |
| ---------------------------- | ------------------------------------- | -------------------------------------- |
| `namespace-member`           | `useFn(client.user)`                  | member `user`                          |
| `namespace-member-member`    | `useFn(client.user.create)`           | member `user`, operation `user.create` |
| `string`                     | `useFn("GetUser")`                    | member `GetUser`                       |
| `imported-identifier`        | `useFn(GetUserDocument)`              | member `GetUserDocument`               |
| `object-property-identifier` | `useFn({ query: GetUserDocument })`   | member `GetUserDocument`               |
| `object-property-string`     | `useFn({ operationName: "GetUser" })` | member `GetUser`                       |

The `object-property-*` variants require an `objectProperty` field naming the key to read. You can list **multiple entries with the same hook name and different `argStyle` values** — the scanner runs every matching pattern, so a preset can accept e.g. both `useQuery(Doc)` and `useQuery({ query: Doc })` simultaneously.

## Programmatic API

```ts
import {
  loadConfig,
  resolvePackageConfig,
  scanDirs,
  prune,
  ShakerCache,
} from "pkg-optimize";

const { config } = loadConfig();
for (const pkg of config.packages) {
  const resolved = await resolvePackageConfig(pkg, config, process.cwd());
  const cache = new ShakerCache(
    resolved.cache.dir,
    resolved.targetPackage,
    process.cwd()
  );
  if (!cache.isCached()) cache.prime();

  const usageMap = scanDirs(
    resolved.scanDirs,
    process.cwd(),
    resolved.patterns
  );
  const result = prune({
    usageMap,
    config: resolved,
    sourceDir: cache.getCachedPackageDir(),
    targetDir: cache.getLivePackageDir(),
  });
  console.log(result);
  // → { packageName, removed, restored, kept, warnings }
  //   `removed`, `restored`, `kept` are arrays of file labels.
}
```

## License

MIT

# pkg-optimize
