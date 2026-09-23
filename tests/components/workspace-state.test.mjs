import assert from "node:assert/strict";
import { test } from "node:test";
import { demoRecommendations, initialProjects } from "../../lib/procurement/mock-workspace.ts";
import {
  approvalBlockers, canPreview, clearSupplierCheck, createApprovedSnapshot, formatDecimal, hasManualChanges,
  scopeChanged, validateQuantity,
} from "../../lib/procurement/review-state.ts";

test("decimal quantity uses exact step arithmetic and canonical strings", () => {
  assert.deepEqual(validateQuantity("0012,50", "0.5"), { ok: true, value: "12.5" });
  assert.deepEqual(validateQuantity("0", "0.5"), { ok: true, value: "0" });
  assert.deepEqual(validateQuantity("9007199254740993.5", "0.5"), { ok: true, value: "9007199254740993.5" });
  for (const value of ["", "-1", "1.2", "1e4", "NaN", "Infinity", "1 000", "1,2.5", "1,,5", "9".repeat(65)]) {
    assert.equal(validateQuantity(value, "0.5").ok, false, value);
  }
  assert.equal(formatDecimal("9007199254740993.5"), "9 007 199 254 740 993,5");
});

test("scope changes make a result stale", () => {
  const original = initialProjects[0].runs[0].scope;
  assert.equal(scopeChanged(original, { ...original }), false);
  assert.equal(scopeChanged(original, { ...original, category: "Кабель" }), true);
  assert.equal(scopeChanged(original, { ...original, asOfDate: "2026-09-21" }), true);
});

test("manual edit requires save, reason and supplier recheck before approval", () => {
  const rows = demoRecommendations;
  const checked = new Set(["volta", "cable"]);
  const state = (drafts = {}, saved = {}, checkedSuppliers = checked) => approvalBlockers({
    scenario: "success", ready: true, stale: false, rows, drafts, saved, checkedSuppliers,
  });
  assert.deepEqual(state(), []);
  assert.equal(hasManualChanges(rows, { "r-001": { quantity: "20", reason: "Проверка" } }, {}), true);
  assert.match(state({ "r-001": { quantity: "20", reason: "Проверка" } }).join(" "), /Сохраните правку/);
  assert.match(state({}, { "r-001": { quantity: "20", reason: "" } }).join(" "), /причину/);
  assert.match(state({}, { "r-001": { quantity: "20", reason: "Проверка" } }, new Set(["cable"])).join(" "), /Проверьте каждого поставщика/);
  assert.deepEqual([...clearSupplierCheck(checked, "volta")], ["cable"]);
  assert.deepEqual([...checked], ["volta", "cable"]);
  assert.deepEqual(state({}, { "r-001": { quantity: "20", reason: "Проверка" } }), []);
  assert.match(approvalBlockers({ scenario: "disconnected", ready: true, stale: false, rows, drafts: {}, saved: {}, checkedSuppliers: checked }).join(" "), /Нет завершённого/);
});

test("approved preview is a frozen data snapshot with no file side effect", () => {
  const saved = { "r-001": { quantity: "0.0", reason: "Отказ от заказа" } };
  const snapshot = createApprovedSnapshot("demo-almaty", "run-a1", demoRecommendations, saved);
  assert.equal(snapshot.rows.some((row) => row.sku === "000174"), false);
  assert.equal(snapshot.rows.find((row) => row.sku === "000047")?.quantity, "125.5");
  saved["r-001"].quantity = "30";
  assert.equal(snapshot.rows.some((row) => row.sku === "000174"), false);
  assert.equal("download" in snapshot, false);
  assert.equal(canPreview(snapshot, false, "success"), true);
  assert.equal(canPreview(snapshot, true, "success"), false);
  assert.equal(canPreview(snapshot, false, "disconnected"), false);
  assert.equal(canPreview(null, false, "success"), false);
});
