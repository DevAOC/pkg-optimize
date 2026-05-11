import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectLayout,
  detectMemberDir,
  detectNaming,
  detectPackageConfig,
  scoreConfidence,
} from '../src/detector.js';
import { matchPreset } from '../src/presets/index.js';
import { createWorkspace, type Workspace } from './helpers.js';

describe('detector', () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it('infers nested layout from a fixture with member/<Name>/<sub>/ subdirs', async () => {
    const pkgDir = ws.installFixturePackage(
      'gadget-nested',
      '@example/test-app',
    );
    expect(await detectLayout(pkgDir)).toBe('nested');
  });

  it('infers flat layout from a fixture with member files only', async () => {
    const pkgDir = ws.installFixturePackage(
      'gadget-flat',
      '@example/flat-app',
    );
    expect(await detectLayout(pkgDir)).toBe('flat');
  });

  it('detects member dir', async () => {
    const pkgDir = ws.installFixturePackage(
      'gadget-flat',
      '@example/flat-app',
    );
    expect(await detectMemberDir(pkgDir, 'flat')).toBe('models');
  });

  it('infers PascalCase naming from filenames', async () => {
    const pkgDir = ws.installFixturePackage(
      'gadget-flat',
      '@example/flat-app',
    );
    expect(await detectNaming(pkgDir, 'flat', 'models')).toBe('PascalCase');
  });

  it('infers kebab-case naming from kebab-style fixtures', async () => {
    const pkgDir = ws.installFixturePackage(
      'apollo-flat',
      '@example/kebab-app',
    );
    expect(await detectNaming(pkgDir, 'flat', 'operations')).toBe('kebab-case');
  });

  it('matches Gadget preset for @gadget-client/* package names', () => {
    const preset = matchPreset('@gadget-client/foo');
    expect(preset).not.toBeNull();
    expect(preset?.patterns?.namespace).toBe('api');
    expect(preset?.packageStructure?.layout).toBe('nested');
  });

  it('matches Apollo preset for @apollo/* package names', () => {
    const preset = matchPreset('@apollo/client');
    expect(preset).not.toBeNull();
    expect(preset?.packageStructure?.layout).toBe('flat');
  });

  it('returns no preset for unknown package patterns', () => {
    const preset = matchPreset('some-random-package');
    expect(preset).toBeNull();
  });

  it('matches urql preset for urql / @urql/* package names', () => {
    expect(matchPreset('urql')?.patterns?.namespace).toBe('graphql');
    expect(matchPreset('@urql/core')).not.toBeNull();
  });

  it('matches relay preset for react-relay', () => {
    const preset = matchPreset('react-relay');
    expect(preset).not.toBeNull();
    expect(preset?.packageStructure?.memberDir).toBe('__generated__');
  });

  it('matches react-query preset for @tanstack/react-query', () => {
    const preset = matchPreset('@tanstack/react-query');
    expect(preset).not.toBeNull();
    expect(preset?.patterns?.hooks?.find((h) => h.name === 'useMutation')).toBeDefined();
  });

  it('matches swr preset for swr package', () => {
    const preset = matchPreset('swr');
    expect(preset).not.toBeNull();
    expect(preset?.patterns?.hooks?.find((h) => h.name === 'useSWR')).toBeDefined();
  });

  it('matches orval / kubb / graphql-codegen presets', () => {
    expect(matchPreset('orval')).not.toBeNull();
    expect(matchPreset('@orval/core')).not.toBeNull();
    expect(matchPreset('@kubb/swagger-tanstack-query')).not.toBeNull();
    expect(matchPreset('@graphql-codegen/typescript-react-query')).not.toBeNull();
  });

  it('matches destructure-style presets (lodash-es, date-fns, react-icons, radix)', () => {
    expect(matchPreset('lodash-es')?.packageStructure?.layout).toBe('destructure');
    expect(matchPreset('date-fns')?.packageStructure?.layout).toBe('destructure');
    expect(matchPreset('react-icons')?.packageStructure?.layout).toBe('destructure');
    expect(matchPreset('react-icons/fa')?.packageStructure?.layout).toBe('destructure');
    expect(matchPreset('@radix-ui/react-dialog')?.packageStructure?.layout).toBe('destructure');
  });

  it('infers destructure layout for a barrel-of-named-exports package', async () => {
    const pkgDir = ws.installFixturePackage(
      'destructure-flat',
      '@example/destructure-pkg',
    );
    expect(await detectLayout(pkgDir)).toBe('destructure');
    expect(await detectMemberDir(pkgDir, 'destructure')).toBe('.');
  });

  it('still classifies a single-file barrel as "barrel"', async () => {
    const pkgRoot = resolve(ws.root, 'node_modules', 'tiny-barrel');
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      resolve(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'tiny-barrel', main: 'index.js' }),
    );
    writeFileSync(
      resolve(pkgRoot, 'index.js'),
      `export const a = 1; export const b = 2;`,
    );
    expect(await detectLayout(pkgRoot)).toBe('barrel');
  });

  it('produces a full DetectedConfig from a fixture package', async () => {
    ws.installFixturePackage('gadget-nested', '@example/test-app');
    const detected = await detectPackageConfig(
      '@example/test-app',
      ws.root,
    );
    expect(detected.packageStructure?.layout).toBe('nested');
    expect(detected.packageStructure?.memberDir).toBe('models');
    expect(detected.packageStructure?.naming).toBe('PascalCase');
    expect(detected.patterns?.namespace).toBe('api');
    expect(['high', 'medium', 'low']).toContain(detected.confidence);
  });

  it('returns low confidence and warnings when package is not installed', async () => {
    const detected = await detectPackageConfig('@example/missing', ws.root);
    expect(detected.confidence).toBe('low');
    expect(detected.warnings?.length).toBeGreaterThan(0);
  });

  it('scoreConfidence returns "high" when all inputs are defined', () => {
    expect(
      scoreConfidence({
        a: 1,
        b: 'x',
        c: true,
        d: 'y',
        e: 'z',
      }),
    ).toBe('high');
  });

  it('scoreConfidence returns "low" when most are missing', () => {
    expect(
      scoreConfidence({ a: undefined, b: null, c: '', d: undefined }),
    ).toBe('low');
  });
});
