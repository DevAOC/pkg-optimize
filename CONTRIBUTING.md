# Contributing to pkg-optimize

Thanks for your interest in improving `pkg-optimize`. This document covers the
practical bits: how to get the repo running locally, what to check before
opening a PR, and how the project is laid out so you know where things go.

## Code of conduct

Be kind, be specific, assume good faith. Bug reports, design pushback, and
"this is confusing" feedback are all welcome — sharp opinions are fine, sharp
words at people are not.

The full version of what we hold ourselves to is in
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) (Contributor Covenant 2.1),
which also covers how to report violations privately.

## Getting set up

You need **Node.js 22 or newer** (Node 22 LTS or Node 24 LTS). The project
intentionally won't run on EOL Node versions — see the rationale in the
[README](./README.md#requirements).

```bash
git clone git@github.com:DevAOC/pkg-optimize.git
cd pkg-optimize
npm install
```

Available scripts:

| Script               | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run build`      | Build CJS + ESM bundles into `dist/` via `tsup`.          |
| `npm run dev`        | Same as `build`, in watch mode.                           |
| `npm run lint`       | Run `tsc --noEmit` against `src/`.                        |
| `npm test`           | Run the full Vitest suite once.                           |
| `npm run test:watch` | Run Vitest in watch mode.                                 |
| `npm run typecheck`  | Run `tsc --noEmit` against `src/`.                        |
| `npm run changeset`  | Add a changeset describing your change (see below).       |

Before pushing a branch, please run at minimum:

```bash
npm run typecheck && npm test
```

`npm run prepublishOnly` runs `build` + `test` and is what executes on release,
so if both of those pass locally you're in good shape.

## Project layout

```
src/
  cache.ts        # ShakerCache: snapshot + restore of pruned files
  cli.ts          # CLI entry + implementation
  config.ts       # Config loading, validation, preset resolution
  detector.ts     # Package layout/naming auto-detection
  index.ts        # Public programmatic API
  logger.ts       # `debug` namespaces (`dbg`) + `configureLogging` / `primeErrorDebug`
  pruner.ts       # Decides what to remove/restore from a target package
  resolver.ts     # Resolves usage entries to concrete files
  scanner.ts      # AST scan of source files for imports/usage
  watcher.ts      # Watch mode (chokidar)
  presets/        # Built-in presets (JSON)
  types.ts        # Shared types
tests/
  *.test.ts       # Vitest specs (one per src module, plus integration)
  fixtures/       # Synthetic packages + source trees used by tests
  helpers.ts      # Test setup helpers
```

When changing behavior, please add or update a test in `tests/`. Most modules
have a paired `*.test.ts` — try to extend the existing file before creating a
new one.

## Working on the scanner / pruner

These two modules are the core of the project and the easiest place to break
something subtle. A few rules of thumb:

- **Be conservative.** If the scanner can't statically resolve a dynamic
  import, pruning for that package must be disabled (see "Dynamic imports are
  safe by construction" in the README). It is always better to keep an unused
  file than to delete a needed one.
- **Cache before you prune.** Anything the pruner removes must already exist
  in the `ShakerCache` snapshot, otherwise it can't be restored later.
- **Add a fixture.** When fixing a bug or adding a pattern, add a minimal
  fixture under `tests/fixtures/` and a test that would have failed before
  your change.

## Adding or modifying a preset

Presets live in `src/presets/*.json`. Keep `patterns` and `packageStructure`
aligned with the same fields we validate on user config via Zod in
`src/config.ts`. To add one:

1. Drop a new `<name>.json` in `src/presets/`.
2. Add coverage in `tests/presets.test.ts` (and a fixture under
   `tests/fixtures/` if the preset relies on a specific layout).
3. Document it in the preset table in [`README.md`](./README.md).

Presets exported via the package's `./presets/*` subpath export are part of
the public API — renaming or removing one is a breaking change.

## Code style

There's no separate linter config — TypeScript's `strict` mode plus the
existing code style is the bar. A few conventions:

- Prefer small, named functions over long inline blocks.
- Keep public types in `src/types.ts` when they're shared across modules.
- Avoid adding runtime dependencies unless there's a clear reason; this
  package is intended to stay lean.
- No comments that just restate what the code does. Comments should explain
  intent, trade-offs, or non-obvious constraints.

## Commit messages and PRs

- Keep commits focused; squash-and-merge is the default on GitHub, so commit
  hygiene inside a PR matters less than a clear PR title and description.
- PR titles should read like a changelog entry (e.g. _"Fix watcher restart
  loop on cache invalidation"_, not _"watcher fix"_).
- In the PR description, explain **why** the change is needed and call out
  anything reviewers should pay extra attention to (perf-sensitive code,
  edge cases, new public API surface, etc.).
- If your change affects observable behavior, update the relevant section of
  `README.md` in the same PR.

## Changesets

We use [Changesets](https://github.com/changesets/changesets) to manage
versions and the changelog. **Any PR that affects published behavior needs a
changeset.** Internal-only changes (refactors with no observable effect, test
tweaks, doc fixes, CI config) don't.

To add one:

```bash
npm run changeset
```

The CLI will ask you to pick a bump type and write a one-line summary:

- **patch** — bug fixes, perf wins, internal changes that touch published
  output but don't change the API.
- **minor** — new flags, new presets, new public API surface, new behavior
  that is opt-in or backward-compatible.
- **major** — anything that breaks an existing config, removes a preset,
  changes default behavior in a way users might notice, or alters the
  programmatic API signatures. While the package is `0.x`, breaking changes
  are released as minor bumps per semver convention — but mark them as
  `major` in the changeset anyway so the changelog is accurate.

Commit the generated `.changeset/*.md` file with the rest of your PR. The
summary you write becomes a bullet in `CHANGELOG.md`, so write it for users:
_"Skip pruning when a target package contains a dynamic `require()`"_, not
_"Update pruner.ts"_.

## Reporting bugs

Useful bug reports include:

- The version of `pkg-optimize` and Node.
- The target package(s) you were pruning and, if possible, a minimal repro
  (a single file's worth of `import`s plus the relevant config is usually
  enough).
- The full warning/error output from `pkg-optimize` (it prints why pruning
  was disabled or skipped).
- What you expected to happen vs. what actually happened.

Please open issues at
<https://github.com/DevAOC/pkg-optimize/issues>.

## Releases

Releases are fully automated by Changesets and GitHub Actions:

1. Every PR that should ship to npm includes a changeset (see above).
2. When that PR merges to `main`, the **Release** workflow opens (or
   updates) a `chore: version packages` PR. That PR contains the version
   bumps and `CHANGELOG.md` updates derived from the accumulated
   changesets.
3. When a maintainer merges the `chore: version packages` PR, the same
   workflow runs again, this time publishing the new version to npm with
   provenance and creating a GitHub release.

The release workflow gates publishing on the full CI suite (typecheck +
test + build) — nothing ships if `main` is red. Contributors **do not**
need to bump versions or edit `CHANGELOG.md` themselves; both are
generated from the changesets.

### Experimental releases

Maintainers can publish an installable build from the current commit without
cutting a normal Changesets release:

```bash
npm run release:experimental
```

The script refuses to run with uncommitted changes, then runs `npm ci`,
`npm run lint`, `npm test`, and `npm run build`. If all checks pass, it
temporarily rewrites `package.json` to a version like
`0.0.0-experimental.<git-sha>`, publishes that build to npm with the
`experimental` dist-tag, and restores `package.json` before exiting.
Because this command is meant to run locally, it disables npm provenance for
the experimental publish; normal releases still publish with provenance from
GitHub Actions.
You must be logged in to npm first; run `npm login` or `npm adduser` if
`npm whoami` fails.

Install an experimental build with:

```bash
npm install pkg-optimize@experimental
```

Use this for testing a specific commit in a real project before deciding
whether it should go through the normal `latest` release path. Experimental
releases are intentionally outside the changelog flow, so still add a
changeset before merging anything that should ship to users.

## Verifying the published artifacts

If your PR changes any of the following, you should verify locally that the
published tarball is correct **before** merging — these regressions are easy
to miss in CI and painful to roll back from npm:

- `tsup.config.ts` or anything else that affects `dist/`
- The `files`, `exports`, `bin`, or `main`/`module`/`types` fields in
  `package.json`
- The preset-copy step (anything under `src/presets/` or the `onSuccess`
  hook in `tsup.config.ts`)

Two-step check:

1. **Inspect what would be published**:

   ```bash
   npm publish --dry-run
   ```

   This runs `prepublishOnly` (build + test), prints the final tarball
   contents, and runs npm's publish-time validations — without uploading.
   Eyeball the file list and confirm it matches what you intended (no
   `tests/`, no source maps you didn't want shipped, all expected presets
   present under `dist/presets/`, `CHANGELOG.md` included once it exists,
   etc.).

2. **End-to-end smoke test against a real install**:

   ```bash
   # in the pkg-optimize repo
   npm pack
   # → creates pkg-optimize-<version>.tgz

   # in a separate scratch project
   npm install /absolute/path/to/pkg-optimize-<version>.tgz
   npx pkg-optimize --version
   ```

   This catches issues that `--dry-run` cannot: a broken `bin` shebang,
   ESM/CJS resolution surprises, missing files referenced from runtime
   code, or `dist/presets/*.json` not actually being copied into the
   tarball. Doing this once before a release-affecting PR merges is much
   cheaper than yanking a bad version from npm.

### Pre-release versions (e.g. `next` tag)

For risky releases that need community testing before going to `latest`,
Changesets supports a [pre-release mode][cs-pre] that publishes under a
dist-tag like `next` or `beta`. We don't have it configured by default —
opt in by adding a `pre.json` with `npx changeset pre enter next` on a
release branch, merging changesets, then `pre exit` once stable. Holler
in your PR if you think a change warrants this and we'll set it up
together.

[cs-pre]: https://github.com/changesets/changesets/blob/main/docs/prereleases.md

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./README.md#license) that covers the project.
