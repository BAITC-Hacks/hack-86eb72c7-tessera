import { ForecastModelSchema, type CalculationConfiguration, type CalculationDataset, type ForecastModel } from "../../contracts/calculation";
import type { Product, SeasonalityIndex } from "../../contracts/datasets";
import { addDays, calendarU, daysInMonth, decimal, median, shiftMonth } from "./math";
import type { ModelResult, MonthObservation, PreparedHistory, WarningCode } from "./types";

type Seasonality = { indices: number[]; evidence: ModelResult["seasonality"] };

function serializable(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < 1e21;
}

function normalizeIndices(indices: number[]): number[] | null {
  const mean = indices.reduce((sum, value) => sum + value, 0) / 12;
  if (!(mean > 0) || indices.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return indices.map((value) => value / mean);
}

function suppliedIndices(rows: readonly SeasonalityIndex[]): number[] | null {
  const complete = rows.filter((row) => row.method === "provided" && row.completeness === "complete");
  if (complete.length !== 12 || new Set(complete.map((row) => row.periodMonth)).size !== 12) return null;
  return normalizeIndices([...complete].sort((a, b) => a.periodMonth - b.periodMonth).map((row) => Number(row.indexValue)));
}

function seasonalityFor(months: MonthObservation[], dataset: CalculationDataset, product: Product, configuration: CalculationConfiguration, warnings: WarningCode[]): Seasonality {
  const neutral: Seasonality = { indices: Array<number>(12).fill(1), evidence: { source: "none_fallback", fullCyclesUsed: 0 } };
  if (configuration.run.seasonalityMode === "none") return neutral;
  if (configuration.run.seasonalityMode === "estimated") {
    const years = new Map<string, MonthObservation[]>();
    for (const month of months) {
      const year = month.month.slice(0, 4);
      years.set(year, [...(years.get(year) ?? []), month]);
    }
    const cycles: number[][] = [];
    for (const rows of years.values()) {
      if (rows.length !== 12 || new Set(rows.map((row) => row.month.slice(5, 7))).size !== 12) continue;
      const days = rows.reduce((sum, row) => sum + daysInMonth(row.month), 0);
      const annualMean = rows.reduce((sum, row) => sum + row.dailyMean * daysInMonth(row.month), 0) / days;
      if (!(annualMean > 0)) continue;
      cycles.push(rows.map((row) => row.dailyMean / annualMean));
    }
    if (cycles.length >= 2) {
      const indices = normalizeIndices(Array.from({ length: 12 }, (_, month) => median(cycles.map((cycle) => cycle[month]))));
      if (indices) return { indices, evidence: { source: "estimated", fullCyclesUsed: cycles.length } };
    }
    warnings.push("seasonality_fallback");
  }
  const productIndices = suppliedIndices(dataset.seasonalityIndices.filter((row) => row.productId === product.id));
  if (productIndices) return { indices: productIndices, evidence: { source: "provided", fullCyclesUsed: 0 } };
  const categoryIndices = suppliedIndices(dataset.seasonalityIndices.filter((row) => row.categoryKey === product.categoryKey));
  if (categoryIndices) return { indices: categoryIndices, evidence: { source: "category_fallback", fullCyclesUsed: 0 } };
  warnings.push("seasonality_fallback");
  return neutral;
}

function externalGrowth(dataset: CalculationDataset, product: Product, configuration: CalculationConfiguration, warnings: WarningCode[]): Pick<ForecastModel, "growthMode" | "externalMonthlyFactor"> {
  const neutral = { growthMode: "none", externalMonthlyFactor: null } as const;
  const source = dataset.version.sourceCompleteness.find((item) => item.sourceType === "growth");
  if (source?.status === "explicit_none") return neutral;
  if (source?.status !== "complete") {
    warnings.push("growth_source_missing");
    return neutral;
  }
  const applicable = dataset.growthAssumptions.filter((item) => item.categoryKey === product.categoryKey && item.effectiveFrom <= configuration.run.asOfDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || a.id.localeCompare(b.id));
  const assumption = applicable[0];
  if (!assumption) {
    warnings.push("growth_source_missing");
    return neutral;
  }
  const semantics = configuration.policies.growthSemanticsByAssumption.find((item) => item.growthAssumptionId === assumption.id);
  if (!semantics || applicable.filter((item) => item.effectiveFrom === assumption.effectiveFrom).length !== 1) {
    warnings.push("growth_semantics_unconfirmed");
    return neutral;
  }
  const value = Number(assumption.growthRate);
  const factor = semantics.valueKind === "multiplier" ? value : 1 + value / (semantics.valueKind === "percent" ? 100 : 1);
  if (value < 0 || !Number.isFinite(factor) || factor <= 0) {
    warnings.push("growth_semantics_unconfirmed");
    return neutral;
  }
  const mode = configuration.run.growthMode;
  if (mode === "none") {
    if (factor !== 1) warnings.push("growth_semantics_unconfirmed");
    return neutral;
  }
  if (mode === "incremental" && !semantics.independentIncrementConfirmed) {
    warnings.push("growth_semantics_unconfirmed");
    return neutral;
  }
  const monthlyFactor = semantics.period === "year" ? factor ** (1 / 12) : factor;
  if (!serializable(monthlyFactor)) {
    warnings.push("growth_semantics_unconfirmed");
    return neutral;
  }
  const serialized = decimal(monthlyFactor);
  if (serialized === "0") {
    warnings.push("growth_semantics_unconfirmed");
    return neutral;
  }
  return { growthMode: mode, externalMonthlyFactor: serialized };
}

function consecutive(months: MonthObservation[]): boolean {
  return months.every((month, index) => index === 0 || shiftMonth(months[index - 1].month, 1) === month.month);
}

/** Полные месяцы → сезонность → устойчивый тренд → календарный якорь. */
export function buildModel(history: PreparedHistory, dataset: CalculationDataset, product: Product, configuration: CalculationConfiguration): ModelResult {
  const warnings: WarningCode[] = [];
  const emptyTrend: ModelResult["trend"] = { status: "insufficient_evidence", recentMedian: null, priorMedian: null, confirmingPairs: 0 };
  const months = history.months.filter((month) => month.full && addDays(shiftMonth(month.month, 1), -1) <= configuration.run.asOfDate)
    .sort((a, b) => a.month.localeCompare(b.month));
  if (history.months.some((month) => !month.full && month.month <= configuration.run.asOfDate)) warnings.push("incomplete_month_excluded");
  const seasonality = seasonalityFor(months, dataset, product, configuration, warnings);
  const unavailable = (reason: string): ModelResult => ({
    model: null, baseAnchor: null, seasonality: seasonality.evidence, trend: emptyTrend,
    warnings: [...new Set([...warnings, "forecast_unavailable" as const])], unavailableReason: reason,
  });
  if (history.unavailableReason) return unavailable(history.unavailableReason);
  if (months.some((month) => !serializable(month.dailyMean)) || seasonality.indices.some((index) => !serializable(index))) {
    return unavailable("numeric_range_exceeded");
  }
  if (months.length < 3 || !consecutive(months.slice(-3))) {
    warnings.push("short_history", "trend_insufficient_evidence");
    return unavailable("insufficient_complete_months");
  }
  // Нулевой сезонный знаменатель не превращаем в бесконечный базовый спрос.
  if (months.slice(-6).some((month) => seasonality.indices[Number(month.month.slice(5, 7)) - 1] === 0)) {
    seasonality.indices = Array<number>(12).fill(1);
    seasonality.evidence = { source: "none_fallback", fullCyclesUsed: 0 };
    warnings.push("seasonality_fallback");
  }
  const deseasonalized = months.map((month) => ({ ...month, dailyMean: month.dailyMean / seasonality.indices[Number(month.month.slice(5, 7)) - 1] }));
  if (deseasonalized.slice(-6).some((month) => !serializable(month.dailyMean))) return unavailable("numeric_range_exceeded");
  const lastThree = deseasonalized.slice(-3);
  const baseAnchor = median(lastThree.map((month) => month.dailyMean));
  let trend = emptyTrend;
  let monthlyTrend = 1;
  const lastSix = deseasonalized.slice(-6);
  if (lastSix.length === 6 && consecutive(lastSix)) {
    const prior = lastSix.slice(0, 3).map((month) => month.dailyMean);
    const recent = lastSix.slice(3).map((month) => month.dailyMean);
    const priorMedian = median(prior);
    const recentMedian = median(recent);
    const confirmingPairs = recent.filter((value, index) => value > prior[index]).length;
    trend = { status: priorMedian > 0 ? "not_confirmed" : "insufficient_evidence", recentMedian: decimal(recentMedian), priorMedian: decimal(priorMedian), confirmingPairs };
    if (priorMedian > 0 && recentMedian > priorMedian && confirmingPairs >= 2) {
      const cap = configuration.policies.trendCapsByCategory.find((item) => item.categoryKey === product.categoryKey);
      if (!cap || Number(cap.maxMonthlyTrendFactor) < 1) {
        warnings.push("missing_category_policy");
      } else {
        const estimated = (recentMedian / priorMedian) ** (1 / 3);
        monthlyTrend = Math.min(estimated, Number(cap.maxMonthlyTrendFactor));
        trend.status = monthlyTrend < estimated ? "capped" : "applied";
      }
    }
    if (priorMedian === 0) warnings.push("trend_insufficient_evidence");
  } else {
    warnings.push("trend_insufficient_evidence");
  }
  const startDate = addDays(configuration.run.asOfDate, 1);
  const anchorU = calendarU(lastThree[1].month) + 0.5;
  const baseAtStart = baseAnchor === 0 ? 0 : baseAnchor * monthlyTrend ** (calendarU(startDate) - anchorU);
  if (!serializable(baseAtStart) || !serializable(monthlyTrend)) return unavailable("numeric_range_exceeded");
  const growth = externalGrowth(dataset, product, configuration, warnings);
  const model = ForecastModelSchema.parse({
    startDate, baseAtStart: decimal(baseAtStart), seasonalIndexByMonth: seasonality.indices.map(decimal),
    trendMonthlyFactor: decimal(monthlyTrend), ...growth,
  });
  return { model, baseAnchor: decimal(baseAnchor), seasonality: seasonality.evidence, trend, warnings: [...new Set(warnings)], unavailableReason: null };
}
