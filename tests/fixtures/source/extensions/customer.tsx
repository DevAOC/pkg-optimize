import { api, useAction } from '@gadget-client/test-app';

export function CustomerForm() {
  const create = useAction(api.customer.create);
  // dynamic access — must be ignored
  const dyn = api['unusedModel'];
  return null;
}
