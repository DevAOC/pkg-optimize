---
"pkg-optimize": minor
---

Internal reliability and API polish: non-blocking I/O, stricter config validation, clearer async flow, and cooperative shutdown.

**Fixes**

- Use asynchronous filesystem APIs instead of synchronous reads/writes so file work does not block the process.
- Replace Ajv with Zod for configuration validation.
- Prefer `async`/`await` over chained `.then()` / `.catch()` for control flow.
- Replace some `.filter().map()` chains with reducers to avoid extra iterations.

**Features**

- Added `AbortSignal` / `AbortController` for cleaner shutdown.# An empty message aborts the editor.
