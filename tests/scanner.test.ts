import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDirs, scanFile } from "../src/scanner";
import type { PatternsConfig, UsageMap } from "../src/types";
import { createWorkspace, type Workspace } from "./helpers";

// Generic two-level patterns. Tests that need the literal names
// `api.shopProduct.update` etc. work because the source fixtures happen to use
// those identifiers — they're just examples, not assumptions about the tool.
const MEMBER_PATTERNS: PatternsConfig = {
  namespace: "api",
  accessStyle: "member",
  depth: { member: 1, operation: 2 },
  hooks: [
    { name: "useFindMany", argIndex: 0, argStyle: "namespace-member" },
    { name: "useAction", argIndex: 0, argStyle: "namespace-member-member" },
  ],
};

function emptyUsage(): UsageMap {
  return { members: new Set(), operations: new Set(), files: new Set() };
}

describe("scanner", () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = createWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("detects namespace.member access", async () => {
    const file = resolve(ws.root, "a.ts");
    writeFileSync(file, `import { api } from 'x'; const m = api.shopProduct;`);
    const usage = emptyUsage();
    await scanFile(file, MEMBER_PATTERNS, usage);
    expect(usage.members.has("shopProduct")).toBe(true);
  });

  it("detects namespace.member.operation at depth 2", async () => {
    const file = resolve(ws.root, "a.ts");
    writeFileSync(file, `import { api } from 'x'; api.shopProduct.update({});`);
    const usage = emptyUsage();
    await scanFile(file, MEMBER_PATTERNS, usage);
    expect(usage.members.has("shopProduct")).toBe(true);
    expect(usage.operations.has("shopProduct.update")).toBe(true);
  });

  it("detects namespace-member hook style", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(
      file,
      `import { api, useFindMany } from 'x'; useFindMany(api.shopProduct);`
    );
    const usage = emptyUsage();
    await scanFile(file, MEMBER_PATTERNS, usage);
    expect(usage.members.has("shopProduct")).toBe(true);
  });

  it("detects namespace-member-member hook style", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(
      file,
      `import { api, useAction } from 'x'; useAction(api.shopProduct.update);`
    );
    const usage = emptyUsage();
    await scanFile(file, MEMBER_PATTERNS, usage);
    expect(usage.operations.has("shopProduct.update")).toBe(true);
    expect(usage.members.has("shopProduct")).toBe(true);
  });

  it("detects string-arg hook style", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(file, `useQuery("GetProduct");`);
    const usage = emptyUsage();
    await scanFile(
      file,
      {
        ...MEMBER_PATTERNS,
        hooks: [{ name: "useQuery", argIndex: 0, argStyle: "string" }],
      },
      usage
    );
    expect(usage.members.has("GetProduct")).toBe(true);
  });

  it("detects imported-identifier argStyle", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(
      file,
      `import { GetProductDocument } from './generated';
       useMutation(GetProductDocument);`
    );
    const usage = emptyUsage();
    await scanFile(
      file,
      {
        ...MEMBER_PATTERNS,
        hooks: [
          { name: "useMutation", argIndex: 0, argStyle: "imported-identifier" },
        ],
      },
      usage
    );
    expect(usage.members.has("GetProductDocument")).toBe(true);
  });

  it("detects object-property-identifier argStyle", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(
      file,
      `import { GetProductDocument } from './generated';
       useQuery({ query: GetProductDocument, variables: { id: 1 } });`
    );
    const usage = emptyUsage();
    await scanFile(
      file,
      {
        ...MEMBER_PATTERNS,
        hooks: [
          {
            name: "useQuery",
            argIndex: 0,
            argStyle: "object-property-identifier",
            objectProperty: "query",
          },
        ],
      },
      usage
    );
    expect(usage.members.has("GetProductDocument")).toBe(true);
  });

  it("detects object-property-string argStyle", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(file, `useQuery({ operationName: "GetProduct" });`);
    const usage = emptyUsage();
    await scanFile(
      file,
      {
        ...MEMBER_PATTERNS,
        hooks: [
          {
            name: "useQuery",
            argIndex: 0,
            argStyle: "object-property-string",
            objectProperty: "operationName",
          },
        ],
      },
      usage
    );
    expect(usage.members.has("GetProduct")).toBe(true);
  });

  it("supports multiple patterns for the same hook name", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(
      file,
      `import { GetProductDocument } from './gen';
       useQuery(GetProductDocument);
       useQuery("LegacyQuery");`
    );
    const usage = emptyUsage();
    await scanFile(
      file,
      {
        ...MEMBER_PATTERNS,
        hooks: [
          { name: "useQuery", argIndex: 0, argStyle: "imported-identifier" },
          { name: "useQuery", argIndex: 0, argStyle: "string" },
        ],
      },
      usage
    );
    expect(usage.members.has("GetProductDocument")).toBe(true);
    expect(usage.members.has("LegacyQuery")).toBe(true);
  });

  it("ignores object-property argStyle when property is missing", async () => {
    const file = resolve(ws.root, "a.tsx");
    writeFileSync(file, `useQuery({ variables: {} });`);
    const usage = emptyUsage();
    await scanFile(
      file,
      {
        ...MEMBER_PATTERNS,
        hooks: [
          {
            name: "useQuery",
            argIndex: 0,
            argStyle: "object-property-identifier",
            objectProperty: "query",
          },
        ],
      },
      usage
    );
    expect(usage.members.size).toBe(0);
  });

  it('ignores computed member access (api["product"])', async () => {
    const file = resolve(ws.root, "a.ts");
    writeFileSync(file, `import { api } from 'x'; const m = api["secret"];`);
    const usage = emptyUsage();
    await scanFile(file, MEMBER_PATTERNS, usage);
    expect(usage.members.has("secret")).toBe(false);
  });

  it("ignores patterns inside comments and strings", async () => {
    const file = resolve(ws.root, "a.ts");
    writeFileSync(
      file,
      `// api.commentedRef\nconst x = "api.stringRef";\nconst real = api.realRef;`
    );
    const usage = emptyUsage();
    await scanFile(file, MEMBER_PATTERNS, usage);
    expect(usage.members.has("commentedRef")).toBe(false);
    expect(usage.members.has("stringRef")).toBe(false);
    expect(usage.members.has("realRef")).toBe(true);
  });

  it("handles .tsx and .jsx files", async () => {
    const tsx = resolve(ws.root, "a.tsx");
    const jsx = resolve(ws.root, "b.jsx");
    writeFileSync(tsx, `const x = api.fromTsx;`);
    writeFileSync(jsx, `const x = api.fromJsx;`);
    const usage = emptyUsage();
    await scanFile(tsx, MEMBER_PATTERNS, usage);
    await scanFile(jsx, MEMBER_PATTERNS, usage);
    expect(usage.members.has("fromTsx")).toBe(true);
    expect(usage.members.has("fromJsx")).toBe(true);
  });

  it("skips unparseable files without throwing", async () => {
    const file = resolve(ws.root, "broken.ts");
    writeFileSync(file, `this is not @@@ valid {{{ JS at all`);
    const usage = emptyUsage();
    await expect(
      scanFile(file, MEMBER_PATTERNS, usage)
    ).resolves.toBeUndefined();
  });

  it("detects gadget shopify extension usage (re-exported api + @gadgetinc/preact)", async () => {
    const apiFile = resolve(
      ws.root,
      "extensions/advance-event/src/api.ts"
    );
    const extFile = resolve(
      ws.root,
      "extensions/advance-event/src/MenuModal.tsx"
    );
    mkdirSync(dirname(apiFile), { recursive: true });
    mkdirSync(dirname(extFile), { recursive: true });
    writeFileSync(
      apiFile,
      `import { Client } from '@gadget-client/onelive-pos-app';
export const api = new Client({ environment: 'production' });`
    );
    writeFileSync(
      extFile,
      `import { api } from '../../api';
import { useFindMany } from '@gadgetinc/preact';
useFindMany(api.event, { filter: {} });
useFindMany(api.shopifyInventoryLevel, { first: 250 });`
    );
    const usage = await scanDirs(
      ["extensions"],
      ws.root,
      MEMBER_PATTERNS,
      { target: "@gadget-client/onelive-pos-app" }
    );
    expect(usage.members.has("event")).toBe(true);
    expect(usage.members.has("shopifyInventoryLevel")).toBe(true);
    expect(usage.members.has("shopifyOrder")).toBe(false);
  });

  it("ignores type-only imports from the target package", async () => {
    const file = resolve(ws.root, "a.ts");
    writeFileSync(
      file,
      `import type { Session, ShopifyOrder } from '@gadget-client/test-app';
       import { Client, type ShopifyProduct } from '@gadget-client/test-app';
       const x = api.shopProduct;`
    );
    const usage = emptyUsage();
    await scanFile(file, MEMBER_PATTERNS, usage, {
      target: "@gadget-client/test-app",
    });
    expect(usage.members.has("Session")).toBe(false);
    expect(usage.members.has("ShopifyOrder")).toBe(false);
    expect(usage.members.has("ShopifyProduct")).toBe(false);
    expect(usage.members.has("shopProduct")).toBe(true);
  });

  it("scans across multiple directories", async () => {
    ws.installFixtureSource({ dirs: ["web", "extensions"] });
    const usage = await scanDirs(
      ["web", "extensions"],
      ws.root,
      MEMBER_PATTERNS
    );
    expect(usage.members.has("shopProduct")).toBe(true);
    expect(usage.members.has("shopOrder")).toBe(true);
    expect(usage.members.has("customer")).toBe(true);
    expect(usage.operations.has("shopProduct.update")).toBe(true);
    expect(usage.operations.has("shopProduct.create")).toBe(true);
    expect(usage.operations.has("shopOrder.cancel")).toBe(true);
    expect(usage.operations.has("customer.create")).toBe(true);
    // dynamic + commented references are not picked up.
    expect(usage.members.has("unusedRef")).toBe(false);
    expect(usage.members.has("commentedRef")).toBe(false);
  });

  it("stops promptly when AbortSignal is aborted", async () => {
    ws.installFixtureSource({ dirs: ["web", "extensions"] });
    const ac = new AbortController();
    const scanPromise = scanDirs(
      ["web", "extensions"],
      ws.root,
      MEMBER_PATTERNS,
      {
        signal: ac.signal,
      }
    );
    ac.abort();
    await expect(scanPromise).rejects.toEqual(
      expect.objectContaining({ name: "AbortError" })
    );
  });

  it("throws immediately if the signal is already aborted", async () => {
    ws.installFixtureSource({ dirs: ["web"] });
    const ac = new AbortController();
    ac.abort();
    await expect(
      scanDirs(["web"], ws.root, MEMBER_PATTERNS, { signal: ac.signal })
    ).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
  });
});
