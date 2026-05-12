import { api } from "@gadget-client/test-app";
import { useFindMany, useAction } from "@gadget-client/test-app";

export function ProductList() {
  const products = useFindMany(api.shopProduct);
  const update = useAction(api.shopProduct.update);
  const create = useAction(api.shopProduct.create);
  // direct member access
  const orderModel = api.shopOrder;
  return <div>{products.length}</div>;
}
