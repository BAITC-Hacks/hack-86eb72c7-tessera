import type { CalculationWarning, ForecastEvidence, ForecastModel } from "../../contracts/calculation";

export type WarningCode = CalculationWarning["code"];
export interface DailyObservation {
  date: string;
  rawQty: number;
  regularQty: number;
  restoredQty: number;
  available: boolean;
  known: boolean;
}
export interface MonthObservation {
  month: string;
  dailyMean: number;
  full: boolean;
}
export interface PreparedHistory {
  days: DailyObservation[];
  months: MonthObservation[];
  historyStart: string | null;
  rawSalesQty: number;
  excludedOutlierQty: number;
  stockoutCompensationQty: number;
  outlierExclusions: ForecastEvidence["outlierExclusions"];
  stockoutAdjustments: ForecastEvidence["stockoutAdjustments"];
  customerAnomalyAvailable: boolean;
  warnings: WarningCode[];
  unavailableReason: string | null;
}
export interface ModelResult {
  model: ForecastModel | null;
  baseAnchor: string | null;
  seasonality: ForecastEvidence["seasonality"];
  trend: ForecastEvidence["trend"];
  warnings: WarningCode[];
  unavailableReason: string | null;
}
