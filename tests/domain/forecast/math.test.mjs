import "../load-typescript.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { addDays, calendarU, daysInMonth, decimal, median, parseDate, shiftMonth, sumQuantities } from "../../../lib/domain/forecast/math.ts";

test("Календарь использует UTC, включая високосный февраль и границу года", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-02-29", 1), "2024-03-01");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01");
  assert.equal(daysInMonth("2024-02-01"), 29);
  assert.equal(shiftMonth("2026-01-31", -1), "2025-12-01");
  assert.equal(calendarU("2026-02-01") - calendarU("2026-01-01"), 1);
  assert.throws(() => parseDate("2026-02-29"));
  assert.throws(() => parseDate("2026-2-1"));
});

test("Входные десятичные количества складываются до перехода к модели", () => {
  assert.equal(sumQuantities(["0.1", "0.2"]), 0.3);
  assert.equal(sumQuantities(["0.00000001", "0.00000002"]), 0.00000003);
  assert.equal(sumQuantities(["1", "-0.2"]), 0.8);
  assert.equal(decimal(10), "10");
  assert.equal(decimal(13.2), "13.2");
  assert.equal(decimal(0), "0");
  assert.throws(() => decimal(-1));
  assert.throws(() => decimal(Infinity));
});

test("Медиана не изменяет вход и устойчива к единичному всплеску", () => {
  const values = Object.freeze([10, 1000, 10]);
  assert.equal(median(values), 10);
  assert.equal(median([12, 10]), 11);
  assert.throws(() => median([]));
});
