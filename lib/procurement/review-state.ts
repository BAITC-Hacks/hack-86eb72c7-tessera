import type { Recommendation, Scope, ScenarioId } from "./mock-workspace";

export type DraftEdit = { quantity: string; reason: string };
export type SavedEdit = { quantity: string; reason: string };
export type ApprovedRow = {
  sku: string;
  supplier: string;
  quantity: string;
  unit: string;
  urgency: string;
  explanation: string;
};
export type ApprovedSnapshot = { projectId: string; runId: string; rows: ApprovedRow[] };

function parseParts(value: string): { digits: bigint; scale: number; canonical: string } | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return {
    digits: BigInt(whole + fraction),
    scale: fraction.length,
    canonical: normalizedWhole + (normalizedFraction ? `.${normalizedFraction}` : ""),
  };
}

export function validateQuantity(
  draft: string,
  step: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const text = draft.trim();
  if (!text) return { ok: false, error: "Укажите количество; ноль означает отказ от заказа." };
  if (text.length > 64) return { ok: false, error: "Количество слишком длинное (не более 64 символов)." };
  if ((text.match(/,/g) ?? []).length > 1 || (text.includes(",") && text.includes("."))) {
    return { ok: false, error: "Используйте одну десятичную запятую или точку." };
  }
  const quantity = parseParts(text.replace(",", "."));
  const unit = parseParts(step);
  if (!quantity) return { ok: false, error: "Введите неотрицательное десятичное число без разделителей групп." };
  if (!unit || unit.digits <= BigInt(0)) return { ok: false, error: "Шаг количества настроен неверно." };
  const scale = Math.max(quantity.scale, unit.scale);
  const quantityUnits = quantity.digits * BigInt(10) ** BigInt(scale - quantity.scale);
  const stepUnits = unit.digits * BigInt(10) ** BigInt(scale - unit.scale);
  if (quantityUnits % stepUnits !== BigInt(0)) {
    return { ok: false, error: `Количество должно быть кратно шагу ${formatDecimal(step)}.` };
  }
  return { ok: true, value: quantity.canonical };
}

export function formatDecimal(value: string): string {
  const [whole, fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fraction ? `${grouped},${fraction}` : grouped;
}

export function scopeChanged(left: Scope, right: Scope): boolean {
  return left.warehouseId !== right.warehouseId || left.category !== right.category || left.asOfDate !== right.asOfDate;
}

export function currentQuantity(row: Recommendation, saved: Record<string, SavedEdit>): string {
  return saved[row.id]?.quantity ?? row.recommended;
}

export function isZeroDecimal(value: string): boolean {
  return /^0+(?:\.0+)?$/.test(value);
}

export function clearSupplierCheck(checked: Set<string>, supplierId: string): Set<string> {
  const next = new Set(checked);
  next.delete(supplierId);
  return next;
}

export function canPreview(snapshot: ApprovedSnapshot | null, stale: boolean, scenario: ScenarioId): boolean {
  return Boolean(snapshot && !stale && ["success", "degraded"].includes(scenario));
}

export function hasManualChanges(rows: Recommendation[], drafts: Record<string, DraftEdit>, saved: Record<string, SavedEdit>): boolean {
  return rows.some((row) => {
    const current = currentQuantity(row, saved);
    const reason = saved[row.id]?.reason ?? "";
    const draft = drafts[row.id];
    return current !== row.recommended || Boolean(reason) || Boolean(draft && (draft.quantity !== current || draft.reason !== reason));
  });
}

export function approvalBlockers(args: {
  scenario: ScenarioId;
  ready: boolean;
  stale: boolean;
  rows: Recommendation[];
  drafts: Record<string, DraftEdit>;
  saved: Record<string, SavedEdit>;
  checkedSuppliers: Set<string>;
}): string[] {
  const { scenario, ready, stale, rows, drafts, saved, checkedSuppliers } = args;
  const blockers: string[] = [];
  if (!["success", "degraded"].includes(scenario)) blockers.push("Нет завершённого актуального расчёта.");
  if (!ready) blockers.push("Обязательные данные не готовы.");
  if (stale) blockers.push("Параметры изменены — требуется новый расчёт.");
  if (rows.length === 0) blockers.push("Нет строк для проверки.");
  for (const row of rows) {
    const current = currentQuantity(row, saved);
    const draft = drafts[row.id];
    if (draft && (draft.quantity !== current || draft.reason !== (saved[row.id]?.reason ?? ""))) {
      blockers.push(`Сохраните правку артикула ${row.sku}.`);
    }
    if (current !== row.recommended && !saved[row.id]?.reason.trim()) {
      blockers.push(`Укажите причину изменения артикула ${row.sku}.`);
    }
    if (!validateQuantity(current, row.step).ok) blockers.push(`Исправьте количество артикула ${row.sku}.`);
  }
  const positive = rows.filter((row) => !isZeroDecimal(currentQuantity(row, saved)));
  if (positive.length === 0) blockers.push("Все позиции имеют нулевое количество к заказу.");
  for (const supplierId of new Set(positive.map((row) => row.supplierId))) {
    if (!checkedSuppliers.has(supplierId)) blockers.push("Проверьте каждого поставщика с положительным заказом.");
  }
  return blockers;
}

export function createApprovedSnapshot(
  projectId: string,
  runId: string,
  rows: Recommendation[],
  saved: Record<string, SavedEdit>,
): ApprovedSnapshot {
  return {
    projectId, runId,
    rows: rows.filter((row) => !isZeroDecimal(currentQuantity(row, saved))).map((row) => ({
      sku: row.sku,
      supplier: row.supplier,
      quantity: currentQuantity(row, saved),
      unit: row.unit,
      urgency: row.urgency,
      explanation: row.summary,
    })),
  };
}
