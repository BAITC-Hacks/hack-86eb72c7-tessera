import {
  CalculationPoliciesSchema, ForecastResultSchema, ReplenishmentResultSchema,
  type CalculateRecommendations, type CalculationWarning, type ForecastSeries,
  type ReplenishmentLine, type ReplenishmentResult, type SeriesKey,
} from "../../contracts/calculation";
import {
  CategoryPolicySchema, InboundShipmentSchema, ProductSupplierSchema, StockSnapshotSchema,
  SupplierLeadTimeSchema, SupplierSchema,
} from "../../contracts/datasets";
import { RunConfigurationSchema } from "../../contracts/runs";
import { addDays } from "./dates";
import { ceilToStep, fromScaled, toScaled } from "./decimal";
import { sumDailyForecast } from "./forecast-sum";
import { planInbound } from "./inbound";
import { simulateStockout } from "./urgency";

type WarningCode = CalculationWarning["code"];
type BlockingReason = ReplenishmentResult["coverage"]["blockingReasons"][number];

function sameKey(left: SeriesKey, right: SeriesKey): boolean {
  return left.productId === right.productId && left.warehouseId === right.warehouseId;
}

function blockingReason(code: WarningCode): BlockingReason {
  if (code === "missing_stock" || code === "missing_lead_time") return code;
  if (code === "missing_supplier" || code === "ambiguous_supplier") return "missing_product_mapping";
  if (code === "forecast_unavailable") return "unavailable_quantity";
  return "data_quality";
}

const warningLabels: Partial<Record<WarningCode, string>> = {
  missing_supplier: "не подтверждён поставщик",
  ambiguous_supplier: "поставщик определён неоднозначно",
  missing_lead_time: "не подтверждён единственный срок поставки",
  missing_category_policy: "политика категории отсутствует или противоречит параметрам запуска",
  missing_stock: "нет единственного текущего свободного остатка",
  negative_usable_stock: "свободный остаток отрицательный",
  unit_mismatch: "единицы измерения не согласованы",
  missing_unit_step: "не подтверждён шаг количества",
  forecast_unavailable: "прогноз недоступен",
};

/** Чистый расчёт: исходные DTO не меняются; свободный остаток не уменьшается на резерв повторно. */
export const calculateRecommendations: CalculateRecommendations = (
  forecastInput, inventoryInput, inboundInput, supplierTermsInput, categoryPoliciesInput, configuration,
) => {
  const forecast = ForecastResultSchema.parse(forecastInput);
  const run = RunConfigurationSchema.parse(configuration.run);
  const policies = CalculationPoliciesSchema.parse(configuration.policies);
  const inventory = inventoryInput.map((item) => StockSnapshotSchema.parse(item));
  const inbound = inboundInput.map((item) => InboundShipmentSchema.parse(item));
  const suppliers = supplierTermsInput.suppliers.map((item) => SupplierSchema.parse(item));
  const productSuppliers = supplierTermsInput.productSuppliers.map((item) => ProductSupplierSchema.parse(item));
  const leadTimes = supplierTermsInput.leadTimes.map((item) => SupplierLeadTimeSchema.parse(item));
  const categoryPolicies = categoryPoliciesInput.map((item) => CategoryPolicySchema.parse(item));

  if (forecast.asOfDate !== run.asOfDate) {
    throw new Error("Дата среза прогноза не совпадает с конфигурацией расчёта");
  }
  const sourceRows = [...inventory, ...inbound, ...suppliers, ...productSuppliers, ...leadTimes, ...categoryPolicies];
  if (sourceRows.some((item) => item.datasetVersionId !== forecast.datasetVersionId)
    || new Set(sourceRows.map((item) => item.projectId)).size > 1) {
    throw new Error("Источники относятся к разным проектам или версиям набора данных");
  }
  if (new Set(suppliers.map((item) => item.id)).size !== suppliers.length) {
    throw new Error("Повтор поставщика в справочнике");
  }
  for (const series of forecast.series) {
    if ((run.scope.warehouseIds.length > 0 && !run.scope.warehouseIds.includes(series.key.warehouseId))
      || (run.scope.categoryIds.length > 0 && !run.scope.categoryIds.includes(series.categoryKey))) {
      throw new Error("Ряд прогноза не входит в область расчёта");
    }
    // 07 не применяет неподтверждённый рост: сохраняет нейтральную модель и
    // блокирующее предупреждение. Такая строка ниже станет unavailable, не заказом.
    const blockedGrowthFallback = series.model?.growthMode === "none"
      && forecast.coverage.coverageGate === "incomplete" && !forecast.coverage.canApprove
      && forecast.warnings.some((warning) => warning.severity === "blocking"
        && (warning.code === "growth_semantics_unconfirmed" || warning.code === "growth_source_missing")
        && (warning.key === null || sameKey(warning.key, series.key)));
    if (series.model && ((series.model.growthMode !== run.growthMode && !blockedGrowthFallback)
      || series.model.startDate > addDays(run.asOfDate, 1))) {
      throw new Error("Модель прогноза не согласована с параметрами запуска");
    }
  }

  const warnings: CalculationWarning[] = [...forecast.warnings];
  const reasons = new Set<BlockingReason>(forecast.coverage.blockingReasons);
  const issues: ReplenishmentResult["issues"] = [];
  const groups = new Map<string, ReplenishmentLine[]>();
  const supplierIds = new Set(suppliers.map((item) => item.id));

  function addWarning(code: WarningCode, series: ForecastSeries, lineWarnings: CalculationWarning[]): void {
    const warning: CalculationWarning = { code, severity: "blocking", key: { ...series.key } };
    if (!lineWarnings.some((item) => item.code === code && item.severity === "blocking")) lineWarnings.push(warning);
  }

  for (const series of forecast.series) {
    const lineWarnings = forecast.warnings.filter((item) => item.key === null || sameKey(item.key, series.key));
    const mappings = productSuppliers.filter((item) => item.productId === series.key.productId);
    const candidates = [...new Set(mappings.map((item) => item.supplierId))].sort();
    if (mappings.length !== 1 || !supplierIds.has(mappings[0].supplierId)) {
      const code = mappings.length > 1 ? "ambiguous_supplier" : "missing_supplier";
      issues.push({ key: { ...series.key }, code, candidateSupplierIds: candidates });
      warnings.push({ code, severity: "blocking", key: { ...series.key } });
      reasons.add("missing_product_mapping");
      continue;
    }
    const mapping = mappings[0];
    const lineBase = {
      ...series.key, supplierId: mapping.supplierId, supplierArticle: mapping.supplierSku,
      unit: series.unit, calculationVersion: run.algorithmVersion, datasetVersionId: forecast.datasetVersionId,
    };
    const categoryMatches = categoryPolicies.filter((item) => item.categoryKey === series.categoryKey);
    const category = categoryMatches.length === 1 ? categoryMatches[0] : undefined;
    const safety = run.safetyDaysByCategory.find((item) => item.categoryKey === series.categoryKey);
    if (!category || !safety || category.parameters.safetyDays !== safety.safetyDays
      || category.parameters.reviewPeriodDays !== run.reviewPeriodDays) {
      addWarning("missing_category_policy", series, lineWarnings);
    }
    const possibleLeadTimes = leadTimes.filter((item) => item.supplierId === mapping.supplierId);
    const productLeadTimes = possibleLeadTimes.filter((item) => item.productId === series.key.productId);
    const categoryLeadTimes = possibleLeadTimes.filter((item) => item.productId === null && item.categoryKey === series.categoryKey);
    const defaultLeadTimes = possibleLeadTimes.filter((item) => item.productId === null && item.categoryKey === null);
    const matches = productLeadTimes.length > 0 ? productLeadTimes : categoryLeadTimes.length > 0 ? categoryLeadTimes : defaultLeadTimes;
    const leadTime = matches.length === 1 ? matches[0] : undefined;
    if (!leadTime) addWarning("missing_lead_time", series, lineWarnings);

    const stocks = inventory.filter((item) => sameKey(item, series.key) && item.asOfDate === run.asOfDate);
    const stock = stocks.length === 1 ? stocks[0] : undefined;
    if (!stock) addWarning("missing_stock", series, lineWarnings);
    if (stock && stock.unit !== series.unit) addWarning("unit_mismatch", series, lineWarnings);
    const unitStep = policies.unitSteps.find((item) => item.productId === series.key.productId);
    if (!unitStep) addWarning("missing_unit_step", series, lineWarnings);
    if (unitStep && unitStep.unit !== series.unit) addWarning("unit_mismatch", series, lineWarnings);
    if (mapping.conversion && mapping.conversion.toUnit !== series.unit) addWarning("unit_mismatch", series, lineWarnings);
    if (!series.model) addWarning("forecast_unavailable", series, lineWarnings);

    let line: ReplenishmentLine;
    const reviewPeriodDays = category?.parameters.reviewPeriodDays;
    const horizonDays = leadTime && reviewPeriodDays ? leadTime.days + reviewPeriodDays : null;
    const inboundPlan = horizonDays === null ? null : planInbound(inbound, series.key, series.unit, run.asOfDate, addDays(run.asOfDate, horizonDays));
    if (inboundPlan) lineWarnings.push(...inboundPlan.warnings);
    const unavailable = !category || !safety || !leadTime || !stock || !unitStep || !series.model
      || horizonDays === null || !inboundPlan || inboundPlan.blocking
      || lineWarnings.some((item) => item.severity === "blocking");

    if (unavailable || !category || !safety || !leadTime || !stock || !unitStep || !series.model || !inboundPlan || horizonDays === null) {
      reasons.add("unavailable_quantity");
      const details = lineWarnings.filter((item) => item.severity === "blocking")
        .map((item) => warningLabels[item.code] ?? "недостаточно подтверждённых данных");
      line = {
        ...lineBase, recommendedQty: null, quantityStatus: "unavailable", urgency: "unknown",
        projectedStockoutDate: null, shortageDays: null, numericFactors: [], dataQuality: "unavailable",
        rationale: `Количество заказа недоступно: ${[...new Set(details)].join("; ") || "недостаточно подтверждённых данных"}. Ноль не подставляется; утверждение заблокировано.`,
        evidence: null, warnings: lineWarnings,
      };
    } else {
      const horizonEnd = addDays(run.asOfDate, horizonDays);
      const forecastDemandH = sumDailyForecast(series.model, addDays(run.asOfDate, 1), horizonEnd);
      const safetyStock = safety.safetyDays === 0 ? "0" : sumDailyForecast(series.model, addDays(horizonEnd, 1), addDays(horizonEnd, safety.safetyDays));
      const raw = toScaled(forecastDemandH) + toScaled(safetyStock) - toScaled(stock.quantity) - toScaled(inboundPlan.eligibleInbound);
      const rawNeed = fromScaled(raw > BigInt(0) ? raw : BigInt(0));
      const finalQty = ceilToStep(rawNeed, unitStep.step);
      const stockout = simulateStockout(series.model, run.asOfDate, horizonDays, leadTime.days, stock.quantity, inboundPlan.arrivals);
      const urgency = stockout.urgent ? "urgent" : finalQty === "0" ? "none" : "planned";
      const evidence = {
        leadTimeDays: leadTime.days, reviewPeriodDays: category.parameters.reviewPeriodDays, horizonDays,
        safetyDays: safety.safetyDays, forecastDemandH, safetyStock,
        stockBasis: "free_stock" as const, onHand: null, reserved: null, usableStock: stock.quantity,
        eligibleInbound: inboundPlan.eligibleInbound, inbound: inboundPlan.decisions, rawNeed,
        unitStep: unitStep.step, finalQty, forecast: series.evidence,
      };
      line = {
        ...lineBase, recommendedQty: finalQty, quantityStatus: "known", urgency,
        projectedStockoutDate: stockout.projectedStockoutDate, shortageDays: stockout.shortageDays,
        numericFactors: [
          { code: "baseline", value: series.model.baseAtStart, unit: series.unit },
          { code: "stockout", value: series.evidence.stockoutCompensationQty, unit: series.unit },
          { code: "outlier", value: series.evidence.excludedOutlierQty, unit: series.unit },
          { code: "stock", value: stock.quantity, unit: series.unit },
          { code: "inbound", value: inboundPlan.eligibleInbound, unit: series.unit },
          { code: "lead_time", value: String(leadTime.days), unit: "день" },
          { code: "safety_stock", value: safetyStock, unit: series.unit },
        ],
        dataQuality: lineWarnings.length > 0 || forecast.coverage.coverageGate === "incomplete" ? "limited" : "complete",
        rationale: `Прогноз на ${horizonDays} дн.: ${forecastDemandH}; страховка на ${safety.safetyDays} дн.: ${safetyStock}. Свободный остаток: ${stock.quantity}; учтённые поступления: ${inboundPlan.eligibleInbound}. Потребность: max(0, ${forecastDemandH} + ${safetyStock} − ${stock.quantity} − ${inboundPlan.eligibleInbound}) = ${rawNeed}. Округление вверх с шагом ${unitStep.step}: ${finalQty} ${series.unit}. База: ${series.model.baseAtStart}; сезонный индекс месяца среза: ${series.model.seasonalIndexByMonth[Number(run.asOfDate.slice(5, 7)) - 1]}; месячный тренд: ${series.model.trendMonthlyFactor}; внешний рост: ${series.model.externalMonthlyFactor ?? "не применяется"} (${series.model.growthMode === "replace" ? "замена тренда" : series.model.growthMode === "incremental" ? "дополнение тренда" : "внешний рост отключён"}). Компенсация отсутствия: ${series.evidence.stockoutCompensationQty}; исключённый разовый объём: ${series.evidence.excludedOutlierQty}. ${stockout.urgent ? "Прогнозируется дефицит до возможной новой поставки; заказ срочный." : finalQty === "0" ? "Дополнительный заказ не требуется." : "Плановое пополнение."}`,
        evidence, warnings: lineWarnings,
      };
    }
    for (const warning of lineWarnings) {
      if (!warnings.some((item) => item.code === warning.code && item.severity === warning.severity
        && (item.key === null ? warning.key === null : warning.key !== null && sameKey(item.key, warning.key)))) warnings.push(warning);
      if (warning.severity === "blocking") reasons.add(blockingReason(warning.code));
    }
    const lines = groups.get(mapping.supplierId) ?? [];
    lines.push(line);
    groups.set(mapping.supplierId, lines);
  }
  for (const warning of warnings) if (warning.severity === "blocking") reasons.add(blockingReason(warning.code));
  if (forecast.coverage.customerAnomalyCoverage === "unavailable") reasons.add("data_quality");
  const blockingReasons = [...reasons].sort();
  return ReplenishmentResultSchema.parse({
    datasetVersionId: forecast.datasetVersionId, asOfDate: run.asOfDate, calculationVersion: run.algorithmVersion,
    supplierGroups: [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([supplierId, lines]) => ({
      supplierId, lines: lines.sort((left, right) => left.warehouseId.localeCompare(right.warehouseId) || left.productId.localeCompare(right.productId)),
    })),
    issues, warnings,
    coverage: {
      coverageGate: blockingReasons.length === 0 ? "complete" : "incomplete", blockingReasons,
      customerAnomalyCoverage: forecast.coverage.customerAnomalyCoverage,
      canApprove: run.runMode === "full" && forecast.coverage.canApprove && blockingReasons.length === 0,
    },
  });
};
