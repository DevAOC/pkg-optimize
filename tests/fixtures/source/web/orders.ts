import { api } from "@gadget-client/test-app";

export async function cancelOrder(id: string) {
  return api.shopOrder.cancel({ id });
}

// This is a comment that mentions api.unusedRef — should NOT be detected.
const description = "Talk to api.commentedRef about it";
