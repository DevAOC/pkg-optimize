#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { StdioOptions } from "node:child_process";

const NPM_REGISTRY = "https://registry.npmjs.org";

const workspacePath = (...parts) =>
  resolve(import.meta.dirname, "..", ...parts);

/** Yarn (and other runners) set `npm_config_*` env vars npm does not recognize, which triggers npm 10+ warnings. */
function envForNpm(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_config_")) {
      delete env[key];
    }
  }
  return env;
}

interface RunOptions {
  capture?: boolean;
  stdio?: StdioOptions;
}

async function main() {
  const status = await run("git", ["status", "--porcelain"], {
    capture: true,
  });

  if (status.trim() !== "") {
    console.error(`
You have uncommitted changes

Please commit or stash them before publishing
`);
    process.exit(1);
  }

  await assertNpmAuth();
  await step("Installing dependencies", "npm", ["ci"]);
  await step("Linting", "npm", ["run", "lint"]);
  await step("Testing", "npm", ["run", "test"]);
  await step("Building", "npm", ["run", "build"]);

  try {
    const gitSha = (
      await run("git", ["rev-parse", "--short", "HEAD"], { capture: true })
    ).trim();
    const packageJsonPath = workspacePath("package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

    packageJson.version = `0.0.0-experimental.${gitSha}`;
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );

    console.log(`\nPublishing experimental release: ${packageJson.version}`);
    await run(
      "npm",
      [
        "publish",
        "--registry",
        NPM_REGISTRY,
        "--tag",
        "experimental",
        "--provenance=false",
      ],
      { stdio: "inherit" },
    );
  } finally {
    await run("git", ["checkout", "package.json"]);
  }
}

async function assertNpmAuth() {
  try {
    await run("npm", ["whoami", "--registry", NPM_REGISTRY], {
      capture: true,
    });
  } catch {
    throw new Error(`
You are not logged in to the public npm registry (${NPM_REGISTRY})

Run \`npm login --registry ${NPM_REGISTRY}\` (or \`npm adduser --registry ${NPM_REGISTRY}\`), then retry.
`);
  }
}

async function step(label: string, command: string, args: string[]) {
  console.log(label);
  await run(command, args, { stdio: "inherit" });
}

function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: workspacePath(),
      env: command === "npm" ? envForNpm() : process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : options.stdio,
    });

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveOutput(stdout);
        return;
      }

      reject(
        new Error(
          stderr.trim() ||
            `${command} ${args.join(" ")} exited with code ${code}`,
        ),
      );
    });
  });
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
