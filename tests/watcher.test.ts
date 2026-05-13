import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { startWatcher } from "../src/watcher";
import { createWorkspace, type Workspace } from "./helpers";

describe("startWatcher", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("starts and stops without throwing for a valid workspace", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    ws.installFixtureSource({ dirs: ["web"] });
    ws.writeConfig({
      scanDirs: ["web"],
      packages: [{ target: "@gadget-client/test-app" }],
    });
    const { config, configPath } = await loadConfig(ws.root);
    const stop = await startWatcher({
      config,
      configPath,
      projectRoot: ws.root,
    });
    await expect(stop()).resolves.toBeUndefined();
  });

  it("closes watchers when stop is awaited after abort", async () => {
    ws.installFixturePackage("gadget-nested", "@gadget-client/test-app");
    ws.installFixtureSource({ dirs: ["web"] });
    ws.writeConfig({
      scanDirs: ["web"],
      packages: [{ target: "@gadget-client/test-app" }],
    });
    const { config, configPath } = await loadConfig(ws.root);
    const ac = new AbortController();
    const stop = await startWatcher({
      config,
      configPath,
      projectRoot: ws.root,
      signal: ac.signal,
    });
    ac.abort();
    await expect(stop()).resolves.toBeUndefined();
  });
});
