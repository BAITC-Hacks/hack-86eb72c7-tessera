// Structured Outputs supports a deliberately small schema. All semantic and size
// constraints are validated again after parsing; the model only chooses refs.
const referenceArray = { type: "array", items: { type: "string" } } as const;

export const OPENAI_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["explanations"],
  properties: {
    explanations: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["recommendationId", "evidenceRefs", "warningRefs"],
        properties: { recommendationId: { type: "string" }, evidenceRefs: referenceArray, warningRefs: referenceArray },
      },
    },
  },
} as const;

export function strictObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function exactRefs(value: unknown, allowed: readonly string[], minimum: number, required: readonly string[] = []): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= allowed.length &&
    value.every((ref) => typeof ref === "string" && allowed.includes(ref)) &&
    new Set(value).size === value.length && required.every((ref) => value.includes(ref));
}
