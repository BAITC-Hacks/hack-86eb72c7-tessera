import type {
  CalculationWarning,
  ReplenishmentEvidence,
  SeriesKey,
} from "../../contracts/calculation";
import { InboundShipmentSchema, type InboundShipment } from "../../contracts/datasets";
import { IsoDateSchema } from "../../contracts/primitives";
import { fromScaled, toScaled } from "./decimal";

type InboundPlan = {
  eligibleInbound: string;
  decisions: ReplenishmentEvidence["inbound"];
  warnings: CalculationWarning[];
  blocking: boolean;
  arrivals: { date: string; quantity: string }[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareShipments(left: InboundShipment, right: InboundShipment): number {
  return compareText(left.sourceKey, right.sourceKey)
    || compareText(left.sourceObjectId, right.sourceObjectId)
    || compareText(left.sourceSheet ?? "", right.sourceSheet ?? "")
    || left.sourceRowNumber - right.sourceRowNumber
    || compareText(left.id, right.id);
}

function sameShipmentFacts(left: InboundShipment, right: InboundShipment): boolean {
  return left.expectedOn === right.expectedOn
    && left.quantity === right.quantity
    && left.unit === right.unit
    && left.supplierId === right.supplierId;
}

/** Срез остатков — конец asOfDate; поступления этого дня уже в остатке. */
export function planInbound(
  inbound: readonly InboundShipment[],
  key: SeriesKey,
  unit: string,
  asOfDate: string,
  horizonEnd: string,
): InboundPlan {
  IsoDateSchema.parse(asOfDate);
  IsoDateSchema.parse(horizonEnd);
  if (horizonEnd < asOfDate) throw new RangeError("Конец горизонта раньше даты расчёта");

  const shipments = inbound
    .filter((row) => row.productId === key.productId && row.warehouseId === key.warehouseId)
    .map((row) => InboundShipmentSchema.parse(row))
    .sort(compareShipments);
  const seen = new Map<string, InboundShipment>();
  const decisions: InboundPlan["decisions"] = [];
  const warnings: CalculationWarning[] = [];
  const dailyArrivals = new Map<string, bigint>();
  let eligibleInbound = BigInt(0);
  let blocking = false;

  function warn(code: CalculationWarning["code"], severity: CalculationWarning["severity"]): void {
    if (!warnings.some((warning) => warning.code === code && warning.severity === severity)) {
      warnings.push({ code, severity, key: { ...key } });
    }
    if (severity === "blocking") blocking = true;
  }

  for (const shipment of shipments) {
    const prior = seen.get(shipment.sourceKey);
    const unitMismatch = shipment.unit !== unit;
    if (unitMismatch) warn("unit_mismatch", "blocking");

    let reason: InboundPlan["decisions"][number]["reason"];
    if (prior) {
      reason = "duplicate";
      // Противоречащие копии нельзя разрешать выбором первого файла.
      warn("inbound_duplicate", sameShipmentFacts(prior, shipment) ? "warning" : "blocking");
    } else {
      seen.set(shipment.sourceKey, shipment);
      if (unitMismatch) {
        reason = "unit_mismatch";
      } else if (shipment.expectedOn === null) {
        reason = "without_date";
        warn("inbound_without_date", "warning");
      } else if (shipment.expectedOn <= asOfDate) {
        // В контракте overdue включает исключённые поступления дня среза.
        reason = "overdue";
        warn("inbound_overdue", "warning");
      } else if (shipment.expectedOn > horizonEnd) {
        reason = "after_horizon";
        warn("inbound_after_horizon", "warning");
      } else {
        reason = "within_horizon";
        const quantity = toScaled(shipment.quantity);
        eligibleInbound += quantity;
        dailyArrivals.set(shipment.expectedOn, (dailyArrivals.get(shipment.expectedOn) ?? BigInt(0)) + quantity);
      }
    }

    decisions.push({
      sourceRef: {
        sourceObjectId: shipment.sourceObjectId,
        sourceSheet: shipment.sourceSheet,
        sourceRowNumber: shipment.sourceRowNumber,
      },
      expectedOn: shipment.expectedOn,
      quantity: shipment.quantity,
      counted: reason === "within_horizon",
      reason,
    });
  }

  return {
    eligibleInbound: fromScaled(eligibleInbound),
    decisions,
    warnings,
    blocking,
    arrivals: [...dailyArrivals]
      .sort(([left], [right]) => compareText(left, right))
      .map(([date, quantity]) => ({ date, quantity: fromScaled(quantity) })),
  };
}
