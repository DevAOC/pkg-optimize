/**
 * Generated client is symlinked at `node_modules/@gadget-client/<app>` →
 * `.gadget/client`, with per-model files under each bundle surface
 * (`dist-esm/models/*.js`, etc.) and shared runtime under `connection/`.
 */
import type { PatternsConfig } from "./types";

export const CLIENT_ENTRY = ".gadget/client";

/** Default scan roots (overridable per package / top-level). */
export const DEFAULT_SCAN_DIRS = ["web", "extensions"] as const;

/** How the client is referenced in app source (`api.shopProduct`, hooks, …). */
export const SCAN_PATTERNS: PatternsConfig = {
  namespace: "api",
  accessStyle: "member",
  depth: { member: 1, operation: 2 },
  hooks: [
    { name: "useFindMany", argIndex: 0, argStyle: "namespace-member" },
    { name: "useFindOne", argIndex: 0, argStyle: "namespace-member" },
    { name: "useFindFirst", argIndex: 0, argStyle: "namespace-member" },
    { name: "useAction", argIndex: 0, argStyle: "namespace-member-member" },
    { name: "useBulkAction", argIndex: 0, argStyle: "namespace-member-member" },
    { name: "useGlobalAction", argIndex: 0, argStyle: "namespace-member" },
  ],
};

/**
 * Models the generated `Client.js` / Shopify extension `Provider` stack expect
 * at runtime even when app code never calls `api.session` directly.
 */
export const INFRA_MEMBERS = ["session", "currentSession"] as const;

/**
 * Package entry exports that are not `models/*.js` / `namespaces/*.js` files.
 * The scanner may record these from `import { Client } from '@gadget-client/…'`.
 */
export const NON_MODEL_MEMBERS = [
  "client",
  "jsonvalue",
  "browserclient",
  "gadgetconnection",
] as const;

/**
 * Relative paths (from the package root) whose entire trees must never be
 * pruned — shared client runtime pulled in by `Client.js` / the connection
 * stack, not by per-model exports on the package entry.
 */
export const PRESERVE_DIR_PREFIXES = [
  "dist-esm/connection",
  "dist-cjs/connection",
] as const;

/**
 * Bundle-surface files that must survive even when barrel tracing does not
 * reach them from the package entry re-export list.
 */
export const PRESERVE_REL_PATHS = [
  "dist-esm/Client.js",
  "dist-esm/builder.js",
  "dist-cjs/Client.js",
  "dist-cjs/builder.js",
] as const;

/**
 * Flat member directories pruned per referenced `api.<member>` / hook usage.
 * Each path is relative to the package root; missing dirs are skipped.
 */
export const MEMBER_DIRS = [
  "dist-esm/models",
  "dist-cjs/models",
  "types/models",
  "types-esm/models",
  "dist-esm/namespaces",
  "dist-cjs/namespaces",
  "types/namespaces",
  "types-esm/namespaces",
] as const;

export const EXTENSIONS = [".js", ".d.ts"] as const;

/** Root filenames never removed during pruning. */
export const PRESERVE_FILENAMES = [
  "index.js",
  "index.d.ts",
  "types.js",
  "types.d.ts",
  "package.json",
] as const;

export function isPreservedFilename(filename: string): boolean {
  return (PRESERVE_FILENAMES as readonly string[]).includes(filename);
}

export function isClientTarget(target: string): boolean {
  return /^@gadget-client\//.test(target);
}
