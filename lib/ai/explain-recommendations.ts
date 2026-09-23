import "server-only";
import type { ExplanationInput } from "./explanation-context";
import { explainRecommendationsCore } from "./explain-recommendations-core";
import { resolveProviderConfig } from "./provider-transport";

export async function explainRecommendations(input: ExplanationInput, signal?: AbortSignal) {
  return explainRecommendationsCore(input, resolveProviderConfig("openai", process.env), { signal });
}
