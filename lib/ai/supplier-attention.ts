import "server-only";
import type { AttentionInput } from "./explanation-context";
import { resolveProviderConfig } from "./provider-transport";
import { supplierAttentionCore } from "./supplier-attention-core";

export async function supplierAttention(input: AttentionInput, signal?: AbortSignal) {
  return supplierAttentionCore(input, resolveProviderConfig("nvidia", process.env), { signal });
}
