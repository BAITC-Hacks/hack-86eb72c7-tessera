import { DecimalStringSchema } from "../contracts/primitives";

export const PROMPT_VERSION = "refs-v1";
export const SCHEMA_VERSION = "refs-v1";

export const FACT_LABELS = {
  seasonality: "Сезонность",
  trend: "Тренд",
  growth: "Прирост спроса",
  stockout: "Дни отсутствия товара",
  excluded_anomaly: "Исключённые выбросы",
  stock: "Доступный остаток",
  transit: "Учтённые поставки",
  lead_time: "Срок поставки",
  target: "Целевой запас",
} as const;

export const WARNING_LABELS = {
  unknown_transit: "Поставки в пути не подтверждены.",
  unknown_stockout: "Дни отсутствия товара не подтверждены.",
  mapping_pending: "Сопоставление номенклатуры требует проверки.",
  source_incomplete: "Исходные данные неполные.",
  calculation_assumption: "Проверьте допущения расчёта.",
} as const;

export type FactKind = keyof typeof FACT_LABELS;
export type WarningKind = keyof typeof WARNING_LABELS;
export type Unit = "шт." | "м" | "дн." | "%" | "×";
export type Fact = Readonly<{ factId: string; kind: FactKind; value: string; unit: Unit }>;
export type Warning = Readonly<{ warningId: string; kind: WarningKind }>;
export type Recommendation = Readonly<{
  recommendationId: string;
  evidenceVersion: string;
  deterministicSummary: string;
  facts: readonly Fact[];
  warnings: readonly Warning[];
}>;
export type ExplanationInput = Readonly<{ runId: string; recommendations: readonly Recommendation[] }>;
export type SupplierGroup = Readonly<{
  supplierGroupId: string;
  evidenceVersion: string;
  facts: readonly Fact[];
  warnings: readonly Warning[];
}>;
export type AttentionInput = Readonly<{ runId: string; groups: readonly SupplierGroup[] }>;

export type SafeErrorCode =
  | "CONFIG_UNAVAILABLE" | "INPUT_INVALID" | "REQUEST_TOO_LARGE" | "TIMEOUT" | "CANCELLED"
  | "RATE_LIMITED" | "NETWORK_ERROR" | "PROVIDER_ERROR" | "OUTPUT_TOO_LARGE"
  | "OUTPUT_INVALID" | "REFUSED" | "INCOMPLETE";

export type Usage = Readonly<{ inputTokens?: number; outputTokens?: number }> | null;
export type Provenance = Readonly<{
  origin: "ai" | "deterministic";
  provider: "openai" | "nvidia";
  model: string | null;
  promptVersion: typeof PROMPT_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
  durationMs: number;
  usage: Usage;
  errorCode?: SafeErrorCode;
}>;
export type Explanation = Readonly<{
  recommendationId: string;
  evidenceVersion: string;
  deterministicSummary: string;
  text: string;
  evidenceRefs: readonly string[];
  warningRefs: readonly string[];
  provenance: Provenance;
}>;
export type SupplierAttention = Readonly<{
  supplierGroupId: string;
  evidenceVersion: string;
  text: string;
  factRefs: readonly string[];
  warningRefs: readonly string[];
  provenance: Provenance;
}>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

export function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validFact(value: Fact): boolean {
  return typeof value === "object" && value !== null && validId(value.factId) && own(FACT_LABELS, value.kind) &&
    typeof value.value === "string" && value.value.length <= 32 && DecimalStringSchema.safeParse(value.value).success &&
    ["шт.", "м", "дн.", "%", "×"].includes(value.unit);
}

function validWarning(value: Warning): boolean {
  return typeof value === "object" && value !== null && validId(value.warningId) && own(WARNING_LABELS, value.kind);
}

export function validateRows<T extends { facts: readonly Fact[]; warnings: readonly Warning[]; evidenceVersion: string }>(
  runId: string, rows: readonly T[], idOf: (row: T) => string,
): boolean {
  if (!validId(runId) || !Array.isArray(rows) || rows.length < 1 || rows.length > 8) return false;
  const rowIds = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || !Array.isArray(row.facts) || !Array.isArray(row.warnings)) return false;
    const rowId = idOf(row);
    if (!validId(rowId) || rowIds.has(rowId) || !validId(row.evidenceVersion) ||
        row.facts.length < 1 || row.facts.length > 12 || row.warnings.length > 8) return false;
    rowIds.add(rowId);
    if (row.facts.some((fact: Fact) => !validFact(fact)) || row.warnings.some((warning: Warning) => !validWarning(warning))) return false;
    const refs = [...row.facts.map((fact: Fact) => fact.factId), ...row.warnings.map((warning: Warning) => warning.warningId)];
    if (new Set(refs).size !== refs.length) return false;
  }
  return true;
}

export function validExplanationInput(input: ExplanationInput): boolean {
  return typeof input === "object" && input !== null &&
    validateRows(input.runId, input.recommendations, (row) => row.recommendationId) &&
    input.recommendations.every((row) => typeof row.deterministicSummary === "string" &&
      row.deterministicSummary.length <= 600 && !/[\u0000-\u001f]/.test(row.deterministicSummary));
}

export function validAttentionInput(input: AttentionInput): boolean {
  return typeof input === "object" && input !== null && validateRows(input.runId, input.groups, (row) => row.supplierGroupId);
}

// Build a model-facing allowlist. Neither free-form summary nor source names enter the request.
export function factDto(fact: Fact) {
  return { factId: fact.factId, label: FACT_LABELS[fact.kind], value: fact.value, unit: fact.unit };
}
export function warningDto(warning: Warning) {
  return { warningId: warning.warningId, label: WARNING_LABELS[warning.kind] };
}

export function renderFacts(facts: readonly Fact[], refs: readonly string[]): string {
  const selected = refs.map((ref) => facts.find((fact) => fact.factId === ref)).filter((fact): fact is Fact => Boolean(fact));
  return selected.map((fact) => `${FACT_LABELS[fact.kind]} — ${fact.value} ${fact.unit}`).join("; ");
}
export function renderWarnings(warnings: readonly Warning[]): string {
  return warnings.map((warning) => WARNING_LABELS[warning.kind]).join(" ");
}
