import { ShopifyProductManager } from "./models/ShopifyProduct.js";
import { SessionManager } from "./models/Session.js";
import { UnusedModelManager } from "./models/UnusedModel.js";

export class Client {
  constructor(connection) {
    this.connection = connection;
    this.shopifyProduct = new ShopifyProductManager(connection);
    this.session = new SessionManager(connection);
    this.unusedModel = new UnusedModelManager(connection);
  }
}
