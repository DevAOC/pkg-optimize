import gadget from "./gadget.json";
import apollo from "./apollo.json";
import trpc from "./trpc.json";
import urql from "./urql.json";
import relay from "./relay.json";
import reactQuery from "./react-query.json";
import swr from "./swr.json";
import graphqlRequest from "./graphql-request.json";
import graphqlCodegen from "./graphql-codegen.json";
import orval from "./orval.json";
import kubb from "./kubb.json";
import lodashEs from "./lodash-es.json";
import dateFns from "./date-fns.json";
import reactIcons from "./react-icons.json";
import radix from "./radix.json";
import type { PackageConfig } from "../types";

const PRESETS: Record<string, Partial<PackageConfig>> = {
  // Canonical names (resolvable by `extends: "pkg-optimize/presets/<name>"`).
  "pkg-optimize/presets/gadget": gadget as Partial<PackageConfig>,
  "pkg-optimize/presets/apollo": apollo as Partial<PackageConfig>,
  "pkg-optimize/presets/trpc": trpc as Partial<PackageConfig>,
  "pkg-optimize/presets/urql": urql as Partial<PackageConfig>,
  "pkg-optimize/presets/relay": relay as Partial<PackageConfig>,
  "pkg-optimize/presets/react-query": reactQuery as Partial<PackageConfig>,
  "pkg-optimize/presets/swr": swr as Partial<PackageConfig>,
  "pkg-optimize/presets/graphql-request":
    graphqlRequest as Partial<PackageConfig>,
  "pkg-optimize/presets/graphql-codegen":
    graphqlCodegen as Partial<PackageConfig>,
  "pkg-optimize/presets/orval": orval as Partial<PackageConfig>,
  "pkg-optimize/presets/kubb": kubb as Partial<PackageConfig>,
  "pkg-optimize/presets/lodash-es": lodashEs as Partial<PackageConfig>,
  "pkg-optimize/presets/date-fns": dateFns as Partial<PackageConfig>,
  "pkg-optimize/presets/react-icons": reactIcons as Partial<PackageConfig>,
  "pkg-optimize/presets/radix": radix as Partial<PackageConfig>,

  // Short aliases for convenience.
  gadget: gadget as Partial<PackageConfig>,
  apollo: apollo as Partial<PackageConfig>,
  trpc: trpc as Partial<PackageConfig>,
  urql: urql as Partial<PackageConfig>,
  relay: relay as Partial<PackageConfig>,
  "react-query": reactQuery as Partial<PackageConfig>,
  swr: swr as Partial<PackageConfig>,
  "graphql-request": graphqlRequest as Partial<PackageConfig>,
  "graphql-codegen": graphqlCodegen as Partial<PackageConfig>,
  orval: orval as Partial<PackageConfig>,
  kubb: kubb as Partial<PackageConfig>,
  "lodash-es": lodashEs as Partial<PackageConfig>,
  "date-fns": dateFns as Partial<PackageConfig>,
  "react-icons": reactIcons as Partial<PackageConfig>,
  radix: radix as Partial<PackageConfig>,
};

/**
 * Pattern-matched presets: if the package `target` matches, the preset is auto-applied
 * even when no explicit `extends` is set in the user's config.
 */
const PACKAGE_PATTERNS: Array<{ pattern: RegExp; preset: string }> = [
  { pattern: /^@gadget-client\//, preset: "pkg-optimize/presets/gadget" },
  { pattern: /^@apollo\//, preset: "pkg-optimize/presets/apollo" },
  { pattern: /^@trpc\//, preset: "pkg-optimize/presets/trpc" },
  { pattern: /^urql$/, preset: "pkg-optimize/presets/urql" },
  { pattern: /^@urql\//, preset: "pkg-optimize/presets/urql" },
  { pattern: /^react-relay$/, preset: "pkg-optimize/presets/relay" },
  { pattern: /^@relay\//, preset: "pkg-optimize/presets/relay" },
  {
    pattern: /^@tanstack\/react-query$/,
    preset: "pkg-optimize/presets/react-query",
  },
  { pattern: /^@tanstack\/query-/, preset: "pkg-optimize/presets/react-query" },
  { pattern: /^swr$/, preset: "pkg-optimize/presets/swr" },
  {
    pattern: /^graphql-request$/,
    preset: "pkg-optimize/presets/graphql-request",
  },
  {
    pattern: /^@graphql-codegen\//,
    preset: "pkg-optimize/presets/graphql-codegen",
  },
  { pattern: /^orval$/, preset: "pkg-optimize/presets/orval" },
  { pattern: /^@orval\//, preset: "pkg-optimize/presets/orval" },
  { pattern: /^@kubb\//, preset: "pkg-optimize/presets/kubb" },
  { pattern: /^lodash-es$/, preset: "pkg-optimize/presets/lodash-es" },
  { pattern: /^date-fns$/, preset: "pkg-optimize/presets/date-fns" },
  { pattern: /^react-icons(\/|$)/, preset: "pkg-optimize/presets/react-icons" },
  { pattern: /^@radix-ui\//, preset: "pkg-optimize/presets/radix" },
];

export function loadPreset(name: string): Partial<PackageConfig> | null {
  return PRESETS[name] ?? null;
}

export function matchPreset(
  target: string
): Partial<PackageConfig> | null {
  const match = PACKAGE_PATTERNS.find((p) => p.pattern.test(target));
  return match ? loadPreset(match.preset) : null;
}

export function listPresetNames(): string[] {
  return Object.keys(PRESETS).filter((k) =>
    k.startsWith("pkg-optimize/presets/")
  );
}
