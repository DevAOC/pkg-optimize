export interface ShakerConfig {
  scanDirs?: string[];
  cache?: { dir?: string };
  watch?: { debounceMs?: number; softPruneInDev?: boolean };
  packages: PackageConfig[];
}

export interface PackageConfig {
  /** npm package name as used in imports (e.g. `@gadget-client/app`). */
  target: string;
  /**
   * Optional filesystem root for that package, tried **first** before the
   * default `node_modules/<target>` layout and closest-match search.
   * Absolute path, or relative to the project root. Must contain a `package.json`
   * whose `name` matches `target`.
   */
  entry?: string;
  extends?: string;
  scanDirs?: string[];
  allow?: { include?: string[] };
  patterns?: PatternsConfig;
  packageStructure?: StructureConfig;
}

export interface PatternsConfig {
  /** Root identifier the package is consumed under (e.g. `api`, `client`, `trpc`, `graphql`). */
  namespace: string;
  /** How the namespace is accessed in source. */
  accessStyle: "member" | "destructure";
  /**
   * Documentation hints describing how deep the relevant references go.
   * Reserved for future use; the scanner currently always tracks both
   * member access (depth 1) and member.member access (depth 2).
   */
  depth: { member: number; operation: number };
  /** Function-call patterns that the scanner should match. */
  hooks?: HookPattern[];
}

export type ArgStyle =
  /** `useFn(namespace.member)` — extracts the member name. */
  | "namespace-member"
  /** `useFn(namespace.member.operation)` — extracts both. */
  | "namespace-member-member"
  /** `useFn("MemberName")` — extracts the literal as a member. */
  | "string"
  /** `useFn(ImportedDocument)` — extracts the identifier name as a member. */
  | "imported-identifier"
  /** `useFn({ key: ImportedDocument })` — reads `objectProperty` from the options object. */
  | "object-property-identifier"
  /** `useFn({ key: "MemberName" })` — reads a string from the options object. */
  | "object-property-string";

export interface HookPattern {
  /** The function name to detect (e.g. `useQuery`, `useFragment`, `request`). */
  name: string;
  /** Which positional argument carries the symbol reference. */
  argIndex: number;
  argStyle: ArgStyle;
  /**
   * Used with `object-property-identifier` and `object-property-string`.
   * The property key to read from the options object passed to the hook.
   * e.g. `useQuery({ query: GetProductDocument })` → `objectProperty: "query"`.
   */
  objectProperty?: string;
}

export interface StructureConfig {
  /**
   * How files are organised inside the package:
   *
   * - `flat`: one file per member inside `memberDir` (e.g. `models/Foo.js`).
   * - `nested`: one subdirectory per member inside `memberDir`, with optional
   *   sub-files for operations (e.g. `models/Foo/Foo.js` + `models/Foo/actions/x.js`).
   * - `destructure`: each top-level entry of `memberDir` (or the package root)
   *   is itself a member — file *or* directory. Used for libraries like
   *   `lodash-es`, `date-fns`, `react-icons/*`, `@radix-ui/*`.
   * - `barrel`: entry file(s) mostly re-export from other modules. The pruner
   *   traces static `export { … } from` / `export * from` chains from the
   *   package entry, removes unreachable implementation files, and rewrites
   *   pure barrel files so they no longer reference deleted modules. A true
   *   single-file bundle (no separate modules to drop) is unchanged.
   */
  layout: "flat" | "nested" | "destructure" | "barrel";
  /**
   * Directory containing one file (or subdir) per top-level member. Use `"."`
   * (or omit it for the `destructure` layout) to mean the package root.
   */
  memberDir?: string;
  /** Optional separate directory holding operations on members (flat layout only). */
  operationDir?: string;
  naming: "PascalCase" | "camelCase" | "kebab-case" | "snake_case";
  /** File extensions the pruner is allowed to remove. */
  extensions: string[];
  /** Filenames that must never be removed regardless of usage. */
  preserve: string[];
}

export interface DetectedConfig {
  patterns?: Partial<PatternsConfig>;
  packageStructure?: Partial<StructureConfig>;
  confidence: "high" | "medium" | "low";
  warnings?: string[];
  /**
   * When true, scan and prune must not run for this package (e.g. package entry
   * could not be resolved after `entry`, install path, and search).
   */
  skip?: boolean;
}

export interface UsageMap {
  /** Top-level symbols referenced in source (e.g. `api.product` → `product`). */
  members: Set<string>;
  /** Sub-symbols referenced under a member, formatted as `"member.operation"`. */
  operations: Set<string>;
  /**
   * Direct file references from deep imports — e.g. `import { x } from
   * 'pkg/foo/bar'` records `foo/bar`. The pruner keeps any cached file whose
   * relative path matches an entry here (with or without an extension, and
   * including `<entry>/index.*`).
   */
  files: Set<string>;
  /**
   * Set when the scanner detects a dynamic reference to the target package
   * that it cannot statically resolve (e.g. `await import('pkg')` with no
   * subpath, or `import(somePath)` where `somePath` is a runtime variable).
   * The pruner switches to restore-only mode for that package and emits a
   * warning. Removals are skipped so dynamic imports never break at runtime.
   */
  wildcard?: boolean;
}

export interface PruneResult {
  packageName: string;
  removed: string[];
  restored: string[];
  kept: string[];
  warnings: string[];
}

export interface ResolvedPackageConfig extends PackageConfig {
  patterns: PatternsConfig;
  packageStructure: StructureConfig;
  scanDirs: string[];
  cache: { dir: string };
  watch: { debounceMs: number; softPruneInDev: boolean };
  /** Latest auto-detection result; persisted to `<cache.dir>/_detected.json` for inspection. */
  detected: DetectedConfig;
}

export type RunMode = "run" | "watch";
