export interface ShakerConfig {
  scanDirs?: string[];
  cache?: { dir?: string };
  watch?: { debounceMs?: number; softPruneInDev?: boolean };
  packages: PackageConfig[];
}

export interface PackageConfig {
  target: string;
  /** Override client root; default is `.gadget/client`. */
  entry?: string | string[];
  scanDirs?: string[];
  allow?: { include?: string[] };
}

export interface PatternsConfig {
  namespace: string;
  accessStyle: "member";
  depth: { member: number; operation: number };
  hooks?: HookPattern[];
}

export type ArgStyle =
  | "namespace-member"
  | "namespace-member-member"
  | "string"
  | "imported-identifier"
  | "object-property-identifier"
  | "object-property-string";

export interface HookPattern {
  name: string;
  argIndex: number;
  argStyle: ArgStyle;
  objectProperty?: string;
}

export interface DetectedConfig {
  confidence: "high" | "medium" | "low";
  warnings?: string[];
  skip?: boolean;
}

export interface UsageMap {
  members: Set<string>;
  operations: Set<string>;
  files: Set<string>;
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
  scanDirs: string[];
  cache: { dir: string };
  watch: { debounceMs: number; softPruneInDev: boolean };
  detected: DetectedConfig;
}

export type RunMode = "run" | "watch";

export interface PruneArgs {
  usageMap: UsageMap;
  config: ResolvedPackageConfig;
  sourceDir: string;
  targetDir: string;
  soft?: boolean;
  signal?: AbortSignal;
}

export interface AllowSet {
  members: Set<string>;
  operations: Set<string>;
  files: Set<string>;
}
