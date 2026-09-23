import type { CalculationConfiguration, CalculationDataset } from "../../contracts/calculation";
import type { Product, Sale } from "../../contracts/datasets";
import { addDays, daysInMonth, decimal, median, parseDate, shiftMonth, sumQuantities } from "./math";
import type { DailyObservation, PreparedHistory, WarningCode } from "./types";

type JsonObject = { [key: string]: unknown };
type Period = { start: string; end: string };
type Event = { date: string; customer: string | null; rows: Sale[]; quantity: number };

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function weekStart(date: string): string {
  return addDays(date, -((parseDate(date).getUTCDay() + 6) % 7));
}

function sourceRef(row: Sale) {
  return { sourceObjectId: row.sourceObjectId, sourceSheet: row.sourceSheet, sourceRowNumber: row.sourceRowNumber };
}

function rowOrder(a: Sale, b: Sale): number {
  return a.soldOn.localeCompare(b.soldOn) || a.sourceObjectId.localeCompare(b.sourceObjectId)
    || (a.sourceSheet ?? "").localeCompare(b.sourceSheet ?? "") || a.sourceRowNumber - b.sourceRowNumber || a.id.localeCompare(b.id);
}

/** Период загрузки — полуинтервал; только явно полная экспозиция разрешает нули. */
function sourcePeriods(dataset: CalculationDataset): { periods: Period[]; basis: string | null } {
  const periods: Period[] = [];
  const bases = new Set<string>();
  for (const entry of dataset.version.manifest) {
    const metadata = object(entry.importMetadata);
    if (!metadata) continue;
    if (metadata.forecastBasis === "monthly" || metadata.forecastBasis === "transactions") bases.add(metadata.forecastBasis);
    const sources = Array.isArray(metadata.sources) ? metadata.sources : [];
    for (const candidate of sources) {
      const source = object(candidate);
      if (!source || source.sourceType !== "sales" || source.sourceObjectId !== entry.sourceObjectId
        || source.sheet !== entry.sheet || source.periodCompleteness !== "complete"
        || !["complete", "explicit_none"].includes(String(source.completeness))) continue;
      const period = object(source.period);
      if (typeof period?.startDate === "string" && typeof period.endDate === "string") {
        try {
          parseDate(period.startDate); parseDate(period.endDate);
          if (period.startDate < period.endDate) periods.push({ start: period.startDate, end: period.endDate });
        } catch { /* Непроверенные метаданные не доказывают экспозицию. */ }
      }
    }
  }
  return { periods, basis: bases.size === 1 ? [...bases][0] : null };
}

function mergePeriods(periods: Period[]): Period[] {
  const merged: Period[] = [];
  for (const period of periods.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))) {
    const previous = merged.at(-1);
    if (previous && period.start <= previous.end) previous.end = previous.end > period.end ? previous.end : period.end;
    else merged.push({ ...period });
  }
  return merged;
}

/** Подготовка наблюдений не создаёт продажи там, где полнота источника неизвестна. */
export function prepareSeries(
  dataset: CalculationDataset,
  product: Product,
  warehouseId: string,
  configuration: CalculationConfiguration,
): PreparedHistory {
  const { run } = configuration;
  const cutoff = addDays(run.asOfDate, 1);
  const windowStart = shiftMonth(run.asOfDate, 1 - run.historicalWindowMonths);
  const warnings = new Set<WarningCode>();
  const weekKeys = new Map<string, string>();
  function weekOf(date: string): string {
    let week = weekKeys.get(date);
    if (!week) { week = weekStart(date); weekKeys.set(date, week); }
    return week;
  }
  const result: PreparedHistory = {
    days: [], months: [], historyStart: null, rawSalesQty: 0, excludedOutlierQty: 0,
    stockoutCompensationQty: 0, outlierExclusions: [], stockoutAdjustments: [],
    customerAnomalyAvailable: false, warnings: [], unavailableReason: null,
  };
  const sales = dataset.sales.filter((row) => row.productId === product.id && row.warehouseId === warehouseId
    && row.soldOn >= windowStart && row.soldOn < cutoff).sort(rowOrder);
  const monthly = dataset.monthlySales.filter((row) => row.productId === product.id && row.warehouseId === warehouseId
    && row.periodMonth >= windowStart && row.periodMonth < cutoff)
    .sort((a, b) => a.periodMonth.localeCompare(b.periodMonth) || a.id.localeCompare(b.id));
  const { periods, basis } = sourcePeriods(dataset);
  const useMonthly = basis === "monthly" || (basis !== "transactions" && sales.length === 0 && monthly.length > 0);
  const finish = () => { result.warnings = [...warnings].sort(); return result; };
  if ((useMonthly ? monthly : sales).some((row) => row.unit !== product.unit)) {
    result.unavailableReason = "unit_mismatch"; warnings.add("unit_mismatch"); return finish();
  }
  if (!useMonthly && sales.some((row) => row.operationType !== "sale" || Number(row.quantity) < 0)) {
    result.unavailableReason = "returns_semantics_unconfirmed"; warnings.add("forecast_unavailable"); return finish();
  }
  if (useMonthly) {
    // Месячный факт не превращается в выдуманные дневные/клиентские события.
    for (let month = windowStart; month < cutoff; month = shiftMonth(month, 1)) {
      const rows = monthly.filter((row) => row.periodMonth === month);
      const full = shiftMonth(month, 1) <= cutoff && rows.length > 0
        && rows.every((row) => ["complete", "explicit_none"].includes(row.completeness) && row.quantity !== null);
      if (!full) { if (rows.length) warnings.add("incomplete_month_excluded"); continue; }
      const quantity = sumQuantities(rows.map((row) => row.quantity!));
      result.months.push({ month, dailyMean: quantity / daysInMonth(month), full: true });
      result.rawSalesQty += quantity;
      result.historyStart ??= month;
    }
    warnings.add("customer_anomaly_unavailable");
    if (dataset.stockoutIntervals.some((row) => row.productId === product.id && row.warehouseId === warehouseId
      && row.startsOn < cutoff && row.endsOn > windowStart)) warnings.add("stockout_insufficient_evidence");
    if (!result.months.length) { result.unavailableReason = "history_exposure_unknown"; warnings.add("forecast_unavailable"); }
    return finish();
  }

  const stockouts = mergePeriods(dataset.stockoutIntervals
    .filter((row) => row.productId === product.id && row.warehouseId === warehouseId && row.startsOn < cutoff && row.endsOn > windowStart)
    .map((row) => ({ start: row.startsOn < windowStart ? windowStart : row.startsOn, end: row.endsOn > cutoff ? cutoff : row.endsOn }))
    .filter((period) => period.start < period.end));
  const daily = new Map<string, DailyObservation>();
  const byDate = new Map<string, Sale[]>();
  for (const row of sales) { const rows = byDate.get(row.soldOn) ?? []; rows.push(row); byDate.set(row.soldOn, rows); }
  for (let date = windowStart; date < cutoff; date = addDays(date, 1)) {
    const rawQty = sumQuantities((byDate.get(date) ?? []).map((row) => row.quantity));
    const known = periods.some((period) => period.start <= date && date < period.end);
    const available = !stockouts.some((period) => period.start <= date && date < period.end);
    daily.set(date, { date, rawQty, regularQty: rawQty, restoredQty: rawQty, available, known });
  }
  result.days = [...daily.values()];
  result.historyStart = result.days.find((day) => day.known || byDate.has(day.date))?.date ?? null;
  result.rawSalesQty = sumQuantities(sales.map((row) => row.quantity));
  result.customerAnomalyAvailable = sales.length > 0 && sales.every((row) => row.customerKeyAvailable && row.anonymousCustomerKey !== null);
  if (!result.customerAnomalyAvailable) warnings.add("customer_anomaly_unavailable");

  const provided = dataset.seasonalityIndices.filter((row) => row.method === "provided" && row.completeness === "complete"
    && (row.productId === product.id || (row.productId === null && row.categoryKey === product.categoryKey)));
  const seasonCache = new Map<number, number[]>();
  const normalizedYears = new Set<number>();
  function season(date: string, comparisonDate = date): number {
    const year = Number(comparisonDate.slice(0, 4));
    let indices = seasonCache.get(year);
    if (!indices) {
      const productIndices = provided.filter((row) => row.productId === product.id);
      const chosen = productIndices.length === 12 ? productIndices : provided.filter((row) => row.productId === null);
      if (run.seasonalityMode === "none") {
        indices = Array<number>(12).fill(1);
        normalizedYears.add(year);
      } else if (chosen.length === 12 && new Set(chosen.map((row) => row.periodMonth)).size === 12
        && chosen.every((row) => Number(row.indexValue) > 0)) {
        indices = Array.from({ length: 12 }, (_, month) => Number(chosen.find((row) => row.periodMonth === month + 1)!.indexValue));
        normalizedYears.add(year);
      } else {
        const cycles: number[][] = [];
        for (let priorYear = Number(windowStart.slice(0, 4)); priorYear < year; priorYear++) {
          const months: number[] = [];
          for (let month = 1; month <= 12; month++) {
            const start = `${priorYear}-${String(month).padStart(2, "0")}-01`;
            const observations = result.days.filter((day) => day.date.startsWith(start.slice(0, 7)));
            if (observations.length !== daysInMonth(start) || observations.some((day) => !day.known)) break;
            const available = observations.filter((day) => day.available).map((day) => day.rawQty);
            if (!available.length) break;
            months.push(median(available));
          }
          if (months.length === 12 && months.reduce((sum, value) => sum + value, 0) > 0) {
            const mean = months.reduce((sum, value) => sum + value, 0) / 12;
            cycles.push(months.map((value) => value / mean));
          }
        }
        indices = cycles.length ? Array.from({ length: 12 }, (_, month) => median(cycles.map((cycle) => cycle[month]))) : Array<number>(12).fill(1);
        if (cycles.length) normalizedYears.add(year);
      }
      seasonCache.set(year, indices);
    }
    return indices[Number(date.slice(5, 7)) - 1];
  }

  const documentGroups = new Map<string, Sale[]>();
  for (const row of sales) {
    const key = JSON.stringify([row.sourceObjectId, row.sourceEventId]);
    const rows = documentGroups.get(key) ?? []; rows.push(row); documentGroups.set(key, rows);
  }
  const events: Event[] = [...documentGroups.values()].map((rows) => ({
    date: rows[0].soldOn, customer: rows.every((row) => row.anonymousCustomerKey === rows[0].anonymousCustomerKey) ? rows[0].anonymousCustomerKey : null,
    rows, quantity: sumQuantities(rows.map((row) => row.quantity)),
  })).sort((a, b) => rowOrder(a.rows[0], b.rows[0]));
  if (events.some((event) => event.rows.some((row) => row.soldOn !== event.date))) {
    result.unavailableReason = "inconsistent_event_dates"; warnings.add("forecast_unavailable"); return finish();
  }
  const excluded = new Map<Sale, number>();
  function comparable(current: Event, history: Event[]): { baseline: number; anomaly: boolean } | null {
    const scale = season(current.date);
    const seasonalHistory = normalizedYears.has(Number(current.date.slice(0, 4)))
      ? history : history.filter((event) => event.date.slice(5, 7) === current.date.slice(5, 7));
    const own = current.customer === null ? [] : seasonalHistory.filter((event) => event.customer === current.customer);
    const enough = (items: Event[]) => new Set(items.map((event) => weekOf(event.date))).size >= run.minComparableWeeks;
    const candidates = enough(own) ? own : seasonalHistory;
    if (!enough(candidates)) return null;
    if (!(scale > 0)) return null;
    const values = candidates.filter((event) => season(event.date, current.date) > 0).map((event) => event.quantity / season(event.date, current.date));
    if (!values.length) return null;
    const center = median(values);
    if (!(center > 0)) return null;
    const mad = median(values.map((value) => Math.abs(value - center)));
    const quantity = current.quantity / scale;
    const madLimit = center + Number(run.outlierMadMultiplier) * 1.4826 * mad;
    const ratioLimit = Number(run.outlierMedianMultiplier) * center;
    return { baseline: center * scale, anomaly: quantity > madLimit && quantity > ratioLimit
      && (mad > 0 || quantity - center > Number(run.zeroMadMinimumUnit) / scale) };
  }
  function exclude(event: Event, baseline: number, level: "document" | "customer_week") {
    const remaining = event.rows.map((row) => Math.max(0, Number(row.quantity) - (excluded.get(row) ?? 0)));
    const raw = remaining.reduce((sum, value) => sum + value, 0);
    const amount = Math.max(0, raw - baseline);
    if (!(amount > 0)) return;
    for (let i = 0; i < event.rows.length; i++) {
      const row = event.rows[i]; excluded.set(row, (excluded.get(row) ?? 0) + amount * remaining[i] / raw);
    }
    result.outlierExclusions.push({
      level, anonymousCustomerKey: event.customer, periodStart: event.date,
      rawQty: decimal(raw), excludedQty: decimal(amount), regularQty: decimal(raw - amount),
      comparableBaseline: decimal(baseline), method: "prior_median_mad_union_v1", sourceRefs: event.rows.map(sourceRef),
    });
  }
  for (const event of events) {
    const history = events.filter((prior) => prior.date < event.date && daily.get(prior.date)?.known && daily.get(prior.date)?.available);
    const comparison = comparable(event, history);
    if (comparison?.anomaly) exclude(event, comparison.baseline, "document");
    else if (!comparison) { warnings.add("short_history"); warnings.add("outlier_manual_review"); }
  }
  const weeks = new Map<string, Sale[]>();
  for (const row of sales) {
    if (row.anonymousCustomerKey === null) continue;
    const key = JSON.stringify([row.anonymousCustomerKey, weekOf(row.soldOn)]);
    const rows = weeks.get(key) ?? []; rows.push(row); weeks.set(key, rows);
  }
  const customerWeeks: Event[] = [...weeks.values()].map((rows) => ({ date: weekOf(rows[0].soldOn), customer: rows[0].anonymousCustomerKey,
    rows, quantity: sumQuantities(rows.map((row) => row.quantity)) })).sort((a, b) => a.date.localeCompare(b.date) || rowOrder(a.rows[0], b.rows[0]));
  const completeWeeks = new Set(customerWeeks.map((event) => event.date).filter((start) =>
    Array.from({ length: 7 }, (_, day) => daily.get(addDays(start, day))).every((day) => day?.known && day.available)));
  for (const event of customerWeeks) {
    const history = customerWeeks.filter((prior) => prior.date < event.date && completeWeeks.has(prior.date));
    const comparison = comparable(event, history);
    if (comparison?.anomaly) exclude(event, comparison.baseline, "customer_week");
    else if (!comparison) warnings.add("outlier_manual_review");
  }
  for (const day of result.days) {
    const removed = (byDate.get(day.date) ?? []).reduce((sum, row) => sum + (excluded.get(row) ?? 0), 0);
    day.regularQty = Math.max(0, day.rawQty - removed);
    day.restoredQty = day.regularQty;
    result.excludedOutlierQty += removed;
  }
  for (const interval of stockouts) {
    let observed = 0, comparableQty = 0, added = 0, count = 0, sufficient = true;
    for (let date = interval.start; date < interval.end; date = addDays(date, 1)) {
      const day = daily.get(date)!;
      const weekday = parseDate(date).getUTCDay();
      const candidates = result.days.filter((other) => other.known && other.available
        && parseDate(other.date).getUTCDay() === weekday
        && other.date.slice(5, 7) === date.slice(5, 7));
      const values = candidates.map((other) => other.regularQty);
      count++; observed += day.regularQty;
      if (!day.known || !values.length) { sufficient = false; comparableQty += day.regularQty; continue; }
      const expected = median(values);
      const adjustment = Math.max(0, expected - day.regularQty);
      day.restoredQty += adjustment;
      comparableQty += expected; added += adjustment;
    }
    result.stockoutCompensationQty += added;
    if (!sufficient) warnings.add("stockout_insufficient_evidence");
    result.stockoutAdjustments.push({ startsOn: interval.start, endsOn: interval.end, days: count,
      observedQty: decimal(observed), comparableQty: decimal(comparableQty), addedQty: decimal(added),
      quality: sufficient ? "estimated" : "insufficient_evidence", method: "weekday_season_median_union_v1" });
  }
  for (let month = windowStart; month < cutoff; month = shiftMonth(month, 1)) {
    const observations = result.days.filter((day) => day.date.slice(0, 7) === month.slice(0, 7));
    const known = observations.filter((day) => day.known);
    const full = observations.length === daysInMonth(month) && known.length === observations.length;
    if (!full && observations.some((day) => day.known || day.rawQty > 0)) warnings.add("incomplete_month_excluded");
    if (known.length) result.months.push({ month, dailyMean: known.reduce((sum, day) => sum + day.restoredQty, 0) / known.length, full });
  }
  if (!result.days.some((day) => day.known)) { result.unavailableReason = "history_exposure_unknown"; warnings.add("forecast_unavailable"); }
  return finish();
}
