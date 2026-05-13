import { describe, expect, it } from "vitest";
import { rewriteGadgetClientSource } from "../src/client";

const SAMPLE = `
import { ShopifyProductManager } from "./models/ShopifyProduct.js";
import { SessionManager } from "./models/Session.js";
import { UnusedModelManager } from "./models/UnusedModel.js";
import { InventoryNamespace } from "./namespaces/inventory.js";

export class Client {
  constructor(connection) {
    this.connection = connection;
    this.shopifyProduct = new ShopifyProductManager(connection);
    this.session = new SessionManager(connection);
    this.unusedModel = new UnusedModelManager(connection);
    this.inventory = new InventoryNamespace(connection);
  }
}
`.trim();

describe("rewriteGadgetClientSource", () => {
  it("drops unused model and namespace imports and constructor assignments", () => {
    const result = rewriteGadgetClientSource(
      SAMPLE,
      new Set(["shopifyProduct", "session"])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain("ShopifyProduct");
    expect(result.code).toContain("Session");
    expect(result.code).not.toContain("UnusedModel");
    expect(result.code).not.toContain("InventoryNamespace");
    expect(result.code).not.toContain("./namespaces/inventory.js");
  });

  it("keeps namespaces that are still referenced", () => {
    const result = rewriteGadgetClientSource(
      SAMPLE,
      new Set(["shopifyProduct", "inventory"])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain("InventoryNamespace");
    expect(result.code).not.toContain("UnusedModel");
  });

  it("keeps class braces and getters when constructor loses only pruned assignments", () => {
    const source = `
import { EventManager } from "./models/Event.js";
import { UnusedModelManager } from "./models/UnusedModel.js";

export class OnelivePosAppClient {
  constructor(connection) {
    this.connection = connection;
    this.event = new EventManager(connection);
    this.unusedModel = new UnusedModelManager(connection);
  }

  get actAsAdmin() {
    return false;
  }
}
`.trim();

    const result = rewriteGadgetClientSource(source, new Set(["event"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toMatch(/class OnelivePosAppClient\s*\{/);
    expect(result.code).toContain("get actAsAdmin()");
    expect(result.code).toContain("EventManager");
    expect(result.code).not.toContain("UnusedModel");
    expect(result.code).not.toContain("unusedModel");
  });
});
