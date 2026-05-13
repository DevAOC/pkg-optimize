import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z, type ZodIssue } from "zod";
import { DEFAULT_SCAN_DIRS } from "./constants";
import { isDirectory, pathExists } from "./utils";
import type { ShakerConfig } from "./types";

export const CONFIG_FILENAME = "pkg-optimize.config.json";

const SCAN_DIR_CANDIDATES = ["web", "extensions", "src", "app"] as const;

const packageEntrySchema = z
  .object({
    target: z.string().min(1).optional(),
    targetPackage: z.string().min(1).optional(),
    entry: z.union([z.string(), z.array(z.string())]).optional(),
    scanDirs: z.array(z.string()).optional(),
    allow: z
      .object({
        include: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.target && !data.targetPackage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide target (or legacy targetPackage) for each package entry",
        path: ["target"],
      });
    }
  })
  .transform((data) => {
    const { targetPackage, ...rest } = data;
    const target = rest.target ?? targetPackage;
    return { ...rest, target: target! };
  });

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
  .strict();

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

  const config = validate(raw);

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
  const detected = await detectScanDirs(cwd);
  const inferredScanDirs =
    config.scanDirs && config.scanDirs.length > 0
      ? config.scanDirs
      : detected.length > 0
      ? detected
      : [...DEFAULT_SCAN_DIRS];

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
  const scanDirs = await detectScanDirs(cwd);
  return {
    packages: [],
    scanDirs: scanDirs.length > 0 ? scanDirs : [...DEFAULT_SCAN_DIRS],
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

export function validate(raw: unknown): ShakerConfig {
  const result = shakerConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = formatZodIssues(result.error);
    throw new Error(`Invalid pkg-optimize.config.json: ${detail}`);
  }
  return result.data as ShakerConfig;
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
      return `${suffix} ${issue.message}`.trim();
    })
    .join("; ");
}
