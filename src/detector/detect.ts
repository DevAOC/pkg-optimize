import { isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  CLIENT_ENTRY,
  isClientTarget,
} from "../constants";
import { isDirectory, pathExists } from "../utils";
import type { DetectedConfig } from "../types";
import { resolvePackageEntryAbs } from "./entries";

export type DetectPackageOptions = {
  entry?: string | string[];
};

export async function detectPackageConfig(
  target: string,
  projectRoot: string,
  options: DetectPackageOptions = {}
): Promise<DetectedConfig> {
  const warnings: string[] = [];

  if (!isClientTarget(target)) {
    return {
      confidence: "low",
      skip: true,
      warnings: [
        `pkg-optimize only supports @gadget-client/* packages; got "${target}".`,
      ],
    };
  }

  const packageDir = resolve(projectRoot, "node_modules", target);
  const installedInNodeModules = await pathExists(packageDir);

  if (!installedInNodeModules && !options.entry) {
    return {
      confidence: "low",
      warnings: [
        `Package "${target}" not found in node_modules. Install it or set entry to ".gadget/client".`,
      ],
    };
  }

  let pkgJson: Record<string, unknown> = {};
  if (installedInNodeModules) {
    try {
      pkgJson = JSON.parse(
        await readFile(resolve(packageDir, "package.json"), "utf-8")
      ) as Record<string, unknown>;
    } catch {
      warnings.push(`Could not read package.json for ${target}.`);
    }
  }

  const entryPaths = normalizeEntryPaths(options.entry);
  let contentRoot = installedInNodeModules ? packageDir : projectRoot;

  for (const entryPath of entryPaths) {
    const hit = await tryResolveGadgetEntryAtPath(
      projectRoot,
      entryPath,
      target
    );
    if (hit) {
      contentRoot = hit.root;
      pkgJson = hit.pkgJson;
      break;
    }
  }

  if (!(await resolvePackageEntryAbs(contentRoot, pkgJson))) {
    return {
      confidence: "low",
      skip: true,
      warnings: [
        ...warnings,
        `Could not resolve a package entry for "${target}" from node_modules or entry path(s) (${entryPaths.join(", ")}).`,
      ],
    };
  }

  return { confidence: "high", warnings };
}

function normalizeEntryPaths(
  entry: string | string[] | undefined
): string[] {
  if (entry === undefined) return [CLIENT_ENTRY];
  const arr = Array.isArray(entry) ? entry : [entry];
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

function resolveConfigPath(projectRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(projectRoot, p);
}

async function tryResolveGadgetEntryAtPath(
  projectRoot: string,
  pathConfig: string,
  expectedName: string
): Promise<{ root: string; pkgJson: Record<string, unknown> } | null> {
  const abs = resolveConfigPath(projectRoot, pathConfig);
  if (!(await isDirectory(abs))) return null;
  const pkgPath = resolve(abs, "package.json");
  if (!(await pathExists(pkgPath))) return null;
  try {
    const pj = JSON.parse(
      await readFile(pkgPath, "utf-8")
    ) as Record<string, unknown>;
    if (pj.name !== expectedName) return null;
    if (!(await resolvePackageEntryAbs(abs, pj))) return null;
    return { root: abs, pkgJson: pj };
  } catch {
    return null;
  }
}
