# pkg-optimize

## 0.3.0

### Minor Changes

- [#9](https://github.com/DevAOC/pkg-optimize/pull/9) [`80abc9a`](https://github.com/DevAOC/pkg-optimize/commit/80abc9a610d12932cb19907e543b4532de45c834) Thanks [@DevAOC](https://github.com/DevAOC)! - Adding debug package in favor of picocolors and our own logger

## 0.2.1

### Patch Changes

- [#7](https://github.com/DevAOC/pkg-optimize/pull/7) [`350d57d`](https://github.com/DevAOC/pkg-optimize/commit/350d57d9db7ec918d719e3f3209eb1e7370e0d44) Thanks [@DevAOC](https://github.com/DevAOC)! - Fixed issue with symlink hoist in cache

## 0.2.0

### Minor Changes

- [#3](https://github.com/DevAOC/pkg-optimize/pull/3) [`2952b9f`](https://github.com/DevAOC/pkg-optimize/commit/2952b9fe4230bdef081d61a9bb2ce571b59f320e) Thanks [@DevAOC](https://github.com/DevAOC)! - Internal reliability and API polish: non-blocking I/O, stricter config validation, clearer async flow, and cooperative shutdown.

  **Fixes**

  - Use asynchronous filesystem APIs instead of synchronous reads/writes so file work does not block the process.
  - Replace Ajv with Zod for configuration validation.
  - Prefer `async`/`await` over chained `.then()` / `.catch()` for control flow.
  - Replace some `.filter().map()` chains with reducers to avoid extra iterations.

  **Features**

  - Added `AbortSignal` / `AbortController` for cleaner shutdown.# An empty message aborts the editor.
