import {
  CalculationCoverageSchema,
  type CalculationConfiguration,
  type CalculationDataset,
  type CalculationWarning,
  type ForecastResult,
  type ForecastSeries,
} from "../../contracts/calculation";
import type { SourceCompleteness } from "../../contracts/datasets";

type SourceType = SourceCompleteness["sourceType"];
type BlockingReason = ForecastResult["coverage"]["blockingReasons"][number];

const REQUIRED_SOURCES: readonly SourceType[] = [
  "stock", "inbound", "stockouts", "suppliers", "categories", "growth",
  "product_mapping", "material_statement", "lead_times",
];

export function warningSeverity(code: CalculationWarning["code"]): CalculationWarning["severity"] {
  return [
    "customer_anomaly_unavailable", "stockout_insufficient_evidence", "growth_source_missing",
    "growth_semantics_unconfirmed", "forecast_unavailable", "unit_mismatch", "missing_category_policy",
  ].includes(code) ? "blocking" : "warning";
}

/** Готовность импорта не доказывает наличие источников и количеств для полного расчёта. */
export function calculateCoverage(
  dataset: CalculationDataset,
  configuration: CalculationConfiguration,
  series: readonly ForecastSeries[],
  warnings: readonly CalculationWarning[],
  customerAnomalyAvailable: boolean,
): ForecastResult["coverage"] {
  const reasons = new Set<BlockingReason>();
  const completeness = new Map(dataset.version.sourceCompleteness.map((source) => [source.sourceType, source]));
  const available = (type: SourceType) => {
    const status = completeness.get(type)?.status;
    return status === "complete" || status === "explicit_none";
  };
  const requireSource = (type: SourceType) => {
    const status = completeness.get(type)?.status;
    if (status === "invalid") reasons.add("invalid_source");
    else if (!available(type)) reasons.add("missing_source");
  };

  for (const source of REQUIRED_SOURCES) requireSource(source);
  if (!available("sales") && !available("monthly_sales")) {
    reasons.add(completeness.get("sales")?.status === "invalid" || completeness.get("monthly_sales")?.status === "invalid"
      ? "invalid_source" : "missing_source");
  }
  if (configuration.run.seasonalityMode === "provided") requireSource("seasonality");

  // Явное отсутствие нельзя использовать как маску для фактически переданных строк.
  // Счётчики импорта могут относиться к исходным строкам до нормализации, поэтому
  // точного равенства rowCount длине нормализованного массива здесь не требуется.
  const asOfDate = configuration.run.asOfDate;
  const counts: Partial<Record<SourceType, number>> = {
    sales: dataset.sales.filter((row) => row.soldOn <= asOfDate).length,
    monthly_sales: dataset.monthlySales.filter((row) => row.periodMonth <= asOfDate).length,
    stock: dataset.stockSnapshots.filter((row) => row.asOfDate <= asOfDate).length,
    inbound: dataset.inboundShipments.length,
    stockouts: dataset.stockoutIntervals.filter((row) => row.startsOn <= asOfDate).length,
    suppliers: dataset.suppliers.length,
    categories: dataset.categoryPolicies.length,
    growth: dataset.growthAssumptions.filter((row) => row.effectiveFrom <= asOfDate).length,
    product_mapping: dataset.products.length, lead_times: dataset.supplierLeadTimes.length,
    seasonality: dataset.seasonalityIndices.length,
  };
  for (const source of dataset.version.sourceCompleteness) {
    const count = counts[source.sourceType];
    if (count === undefined) continue;
    if ((source.status === "explicit_none" && count > 0) || (source.status === "complete" && count === 0)) {
      reasons.add("invalid_source");
    }
  }
  if (series.length === 0 || series.some((item) => item.status === "unavailable")) reasons.add("unavailable_quantity");
  if (!customerAnomalyAvailable) reasons.add("data_quality");
  for (const warning of warnings) {
    if (warning.severity !== "blocking") continue;
    if (warning.code === "forecast_unavailable") reasons.add("unavailable_quantity");
    else if (warning.code === "growth_source_missing") reasons.add("missing_source");
    else reasons.add("data_quality");
  }

  const blockingReasons = [...reasons].sort();
  return CalculationCoverageSchema.parse({
    coverageGate: blockingReasons.length === 0 ? "complete" : "incomplete",
    blockingReasons,
    customerAnomalyCoverage: customerAnomalyAvailable ? "available" : "unavailable",
    canApprove: configuration.run.runMode === "full" && blockingReasons.length === 0,
  });
}
