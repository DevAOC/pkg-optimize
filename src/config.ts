import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import type { ShakerConfig } from './types.js';

export const CONFIG_FILENAME = 'pkg-optimize.config.json';

const SCAN_DIR_CANDIDATES = ['src', 'web', 'extensions', 'app'] as const;

export function loadConfig(cwd: string = process.cwd()): {
  config: ShakerConfig;
  configPath: string;
} {
  const configPath = findConfig(cwd);

  if (!configPath) {
    return {
      config: buildZeroConfig(cwd),
      configPath: resolve(cwd, CONFIG_FILENAME),
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${(err as Error).message}`,
    );
  }

  validate(raw);
  const config = raw as ShakerConfig;

  return {
    config: applyTopLevelDefaults(config, dirname(configPath)),
    configPath,
  };
}

export function writeConfig(config: ShakerConfig, configPath: string): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function findConfig(dir: string): string | null {
  let current = resolve(dir);
  while (true) {
    const candidate = resolve(current, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function applyTopLevelDefaults(
  config: ShakerConfig,
  cwd: string,
): ShakerConfig {
  const inferredScanDirs =
    config.scanDirs && config.scanDirs.length > 0
      ? config.scanDirs
      : detectScanDirs(cwd);

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

function buildZeroConfig(cwd: string): ShakerConfig {
  return {
    packages: [],
    scanDirs: detectScanDirs(cwd),
  };
}

export function detectScanDirs(cwd: string): string[] {
  return SCAN_DIR_CANDIDATES.filter((dir) => {
    try {
      return statSync(resolve(cwd, dir)).isDirectory();
    } catch {
      return false;
    }
  });
}

let cachedValidator: ValidateFunction | null = null;

export function validate(raw: unknown): void {
  if (!cachedValidator) {
    cachedValidator = buildValidator();
  }
  const ok = cachedValidator(raw);
  if (!ok) {
    const errors = (cachedValidator.errors ?? [])
      .map((e) => `${e.instancePath || '<root>'} ${e.message ?? ''}`.trim())
      .join('; ');
    throw new Error(`Invalid pkg-optimize.config.json: ${errors}`);
  }
}

function buildValidator(): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });

  const schema = {
    type: 'object',
    additionalProperties: true,
    required: ['packages'],
    properties: {
      scanDirs: {
        type: 'array',
        items: { type: 'string' },
      },
      cache: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
        },
        additionalProperties: false,
      },
      watch: {
        type: 'object',
        properties: {
          debounceMs: { type: 'number', minimum: 0 },
          softPruneInDev: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      packages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['targetPackage'],
          additionalProperties: true,
          properties: {
            targetPackage: { type: 'string', minLength: 1 },
            extends: { type: 'string' },
            scanDirs: { type: 'array', items: { type: 'string' } },
            allow: {
              type: 'object',
              properties: {
                include: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
            patterns: {
              type: 'object',
              properties: {
                namespace: { type: 'string' },
                accessStyle: { type: 'string', enum: ['member', 'destructure'] },
                depth: {
                  type: 'object',
                  properties: {
                    member: { type: 'number' },
                    operation: { type: 'number' },
                  },
                  additionalProperties: false,
                },
                hooks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'argIndex', 'argStyle'],
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      argIndex: { type: 'number', minimum: 0 },
                      argStyle: {
                        type: 'string',
                        enum: [
                          'namespace-member',
                          'namespace-member-member',
                          'string',
                          'imported-identifier',
                          'object-property-identifier',
                          'object-property-string',
                        ],
                      },
                      objectProperty: { type: 'string' },
                    },
                  },
                },
              },
              additionalProperties: false,
            },
            packageStructure: {
              type: 'object',
              properties: {
                layout: {
                  type: 'string',
                  enum: ['flat', 'nested', 'destructure', 'barrel'],
                },
                memberDir: { type: 'string' },
                operationDir: { type: 'string' },
                naming: {
                  type: 'string',
                  enum: ['PascalCase', 'camelCase', 'kebab-case', 'snake_case'],
                },
                extensions: { type: 'array', items: { type: 'string' } },
                preserve: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
            _detected: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
      },
    },
  } as const;

  return ajv.compile(schema);
}
