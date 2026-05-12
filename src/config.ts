import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z, type ZodIssue } from "zod";
import { isDirectory, pathExists } from "./utils";
import type { ShakerConfig } from "./types";

export const CONFIG_FILENAME = "pkg-optimize.config.json";

const SCAN_DIR_CANDIDATES = ["src", "web", "extensions", "app"] as const;

const argStyleEnum = z.enum([
  "namespace-member",
  "namespace-member-member",
  "string",
  "imported-identifier",
  "object-property-identifier",
  "object-property-string",
]);

const hookPatternSchema = z
  .object({
    name: z.string(),
    argIndex: z.number().nonnegative(),
    argStyle: argStyleEnum,
    objectProperty: z.string().optional(),
  })
  .strict();

const patternsSchema = z
  .object({
    namespace: z.string().optional(),
    accessStyle: z.enum(["member", "destructure"]).optional(),
    depth: z
      .object({
        member: z.number(),
        operation: z.number(),
      })
      .strict()
      .optional(),
    hooks: z.array(hookPatternSchema).optional(),
  })
  .strict();

const packageStructureSchema = z
  .object({
    layout: z.enum(["flat", "nested", "destructure", "barrel"]).optional(),
    memberDir: z.string().optional(),
    operationDir: z.string().optional(),
    naming: z
      .enum(["PascalCase", "camelCase", "kebab-case", "snake_case"])
      .optional(),
    extensions: z.array(z.string()).optional(),
    preserve: z.array(z.string()).optional(),
  })
  .strict();

const packageEntrySchema = z
  .object({
    targetPackage: z.string().min(1),
    extends: z.string().optional(),
    scanDirs: z.array(z.string()).optional(),
    allow: z
      .object({
        include: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    patterns: patternsSchema.optional(),
    packageStructure: packageStructureSchema.optional(),
    _detected: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const shakerConfigSchema = z
  .object({
    scanDirs: z.array(z.string()).optional(),
    cache: z
      .object({
        dir: z.string().optional(),
      })
      .strict()
      .optional(),
    watch: z
      .object({
        debounceMs: z.number().nonnegative(),
        softPruneInDev: z.boolean().optional(),
      })
      .strict()
      .optional(),
    packages: z.array(packageEntrySchema),
  })
  .passthrough();

export async function loadConfig(cwd: string = process.cwd()): Promise<{
  config: ShakerConfig;
  configPath: string;
}> {
  const configPath = await findConfig(cwd);

  if (!configPath) {
    return {
      config: await buildZeroConfig(cwd),
      configPath: resolve(cwd, CONFIG_FILENAME),
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }

  validate(raw);
  const config = raw as ShakerConfig;

  return {
    config: await applyTopLevelDefaults(config, dirname(configPath)),
    configPath,
  };
}

export async function writeConfig(
  config: ShakerConfig,
  configPath: string
): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export async function findConfig(dir: string): Promise<string | null> {
  let current = resolve(dir);
  while (true) {
    const candidate = resolve(current, CONFIG_FILENAME);
    if (await pathExists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function applyTopLevelDefaults(
  config: ShakerConfig,
  cwd: string
): Promise<ShakerConfig> {
  const inferredScanDirs =
    config.scanDirs && config.scanDirs.length > 0
      ? config.scanDirs
      : await detectScanDirs(cwd);

  return {
    ...config,
    scanDirs: inferredScanDirs,
    packages: (config.packages ?? []).map((pkg) => ({
      ...pkg,
      scanDirs:
        pkg.scanDirs && pkg.scanDirs.length > 0
          ? pkg.scanDirs
          : inferredScanDirs,
    })),
  };
}

async function buildZeroConfig(cwd: string): Promise<ShakerConfig> {
  return {
    packages: [],
    scanDirs: await detectScanDirs(cwd),
  };
}

export async function detectScanDirs(cwd: string): Promise<string[]> {
  const checks = await Promise.all(
    SCAN_DIR_CANDIDATES.map(async (dir) => ({
      dir,
      isDir: await isDirectory(resolve(cwd, dir)),
    }))
  );
  return checks.reduce<string[]>((acc, c) => {
    if (c.isDir) acc.push(c.dir);
    return acc;
  }, []);
}

export function validate(raw: unknown): void {
  const result = shakerConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = formatZodIssues(result.error);
    throw new Error(`Invalid pkg-optimize.config.json: ${detail}`);
  }
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue: ZodIssue) => {
      const suffix =
        issue.path.length === 0
          ? "<root>"
          : `/${issue.path
              .map((segment: string | number) => String(segment))
              .join("/")}`;
      const message = issue.message;
      return `${suffix} ${message}`.trim();
    })
    .join("; ");
}
