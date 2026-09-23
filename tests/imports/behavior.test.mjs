import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createSyntheticImportFixture } from "../../scripts/generate-import-fixture.ts";
import { ImportManifestSchema, ImportReportSchema } from "../../lib/contracts/imports.ts";
import { normalizeSources } from "../../lib/server/imports/adapters.ts";
import { validateImport } from "../../lib/server/imports/service.ts";

const fixture = await createSyntheticImportFixture();
const salesSource = fixture.manifest.sources.find((source) => source.sourceType === "sales");
function salesCase({ quantity = "10.25", customer = "anon_safe", operation = "sale", formula = false, error = false } = {}) {
  const source = structuredClone(salesSource);
  source.semantics.operationType = operation;
  const fields = source.columnMappings.map((entry) => entry.sourceColumn);
  const values = ["000123", "warehouse-a", "2026-09-01", quantity, "pcs", "event-1", customer];
  const cell = (value, column, row) => ({ address: `${String.fromCharCode(64 + column)}${row}`, column, type: "string", value });
  const cells = values.map((value, index) => cell(value, index + 1, 2));
  if (formula) cells[3] = { ...cells[3], type: "formula", value: null, formula: "1+1" };
  if (error) cells[3] = { ...cells[3], type: "error", value: null, error: "#N/A" };
  return {
    manifest: ImportManifestSchema.parse({ ...fixture.manifest, sources: [source] }),
    workbooks: [{ objectId: source.sourceObjectId, checksum: source.checksum, dateSystem: "1900", sheets: [
      { name: "sales", hash: "a".repeat(64), rows: [{ rowNumber: 1, cells: fields.map((value, index) => cell(value, index + 1, 1)) }, { rowNumber: 2, cells }] },
    ] }],
  };
}
function normalize(options) {
  const input = salesCase(options);
  return normalizeSources(input.manifest, input.workbooks);
}

test("синтетический XLSX покрывает все 12 ролей и имеет точный checksum", () => {
  assert.equal(new Set(fixture.manifest.sources.map((source) => source.sourceType)).size, 12);
  const checksum = createHash("sha256").update(fixture.objects[0].bytes).digest("hex");
  assert.ok(fixture.manifest.sources.every((source) => source.origin === "synthetic" && source.checksum === checksum));
});

test("артикул с ведущими нулями, точное количество и происхождение сохраняются", () => {
  const result = normalize({ quantity: "1234567890123456789012.12345678" });
  ImportReportSchema.parse(result.report);
  assert.equal(result.report.acceptedRows, 1);
  const row = result.normalizedDraft.rows[0];
  assert.equal(row.values.sku, "000123");
  assert.equal(row.values.quantity, "1234567890123456789012.12345678");
  assert.equal(row.sourceRowNumber, 2);
  assert.equal(row.sourceSheet, "sales");
});

test("возврат остаётся отрицательным, неизвестный документ не становится продажей", () => {
  const returned = normalize({ operation: "return", quantity: "-2.5" });
  assert.equal(returned.report.acceptedRows, 1);
  assert.equal(returned.normalizedDraft.rows[0].values.quantity, "-2.5");
  const unknown = normalize({ operation: "unresolved" });
  assert.equal(unknown.report.acceptedRows, 0);
  assert.equal(unknown.report.unresolvedRows, 1);
});

test("ошибка Excel и пустой кеш формулы не становятся нулём", () => {
  for (const options of [{ formula: true }, { error: true }]) {
    const result = normalize(options);
    assert.equal(result.report.acceptedRows, 0);
    assert.equal(result.normalizedDraft.rows.length, 0);
    assert.ok(result.report.rejectedRows + result.report.unresolvedRows > 0);
  }
});

test("нет ID клиента — нет подмены номером документа; stockout не выдумывается", () => {
  const result = normalize({ customer: null });
  assert.equal(result.report.customerAnomalyCoverage, "unavailable");
  assert.equal(result.report.sourceCompleteness.find((source) => source.sourceType === "stockouts").status, "missing");
  assert.equal(result.normalizedDraft.rows.some((row) => row.sourceType === "stockouts"), false);
});

test("потенциальные клиентские идентификаторы блокируются без утечки значений", () => {
  const result = normalize({ customer: "person@example.test" });
  assert.equal(result.report.acceptedRows, 0);
  assert.equal(JSON.stringify(result.report).includes("person@example.test"), false);
});

test("explicit_none требует автора и основания и отличается от missing", () => {
  const input = salesCase();
  const empty = { ...input.manifest.sources[0], sourceType: "stockouts", sourceObjectId: null, checksum: null, sheet: null,
    completeness: "explicit_none", columnMappings: [], confirmedByUserId: "synthetic_owner", confirmationReason: "Проверенный синтетический сценарий" };
  const manifest = ImportManifestSchema.parse({ ...input.manifest, sources: [...input.manifest.sources, empty] });
  const result = normalizeSources(manifest, input.workbooks);
  assert.equal(result.report.sourceCompleteness.find((source) => source.sourceType === "stockouts").status, "explicit_none");
  assert.throws(() => ImportManifestSchema.parse({ ...manifest, sources: [{ ...empty, confirmedByUserId: null }] }));
});

test("полный путь XLSX → парсер → сервис воспроизводит одинаковый отчёт", async () => {
  const first = await validateImport(fixture.manifest, fixture.objects);
  const second = await validateImport(fixture.manifest, fixture.objects);
  ImportReportSchema.parse(first.report);
  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.checkedRows > 0, true);
  assert.equal(first.status, "ready", JSON.stringify(first.report.issues));
});

test("несовпадение checksum отклоняется до принятия строк", async () => {
  const manifest = structuredClone(fixture.manifest);
  manifest.sources.forEach((source) => { source.checksum = "f".repeat(64); });
  const result = await validateImport(manifest, fixture.objects);
  assert.equal(result.status, "invalid");
  assert.equal(result.normalizedDraft, null);
});

test("неизвестная роль отклоняется контрактом", () => {
  const manifest = structuredClone(fixture.manifest);
  manifest.sources[0].sourceType = "unknown_source";
  assert.throws(() => ImportManifestSchema.parse(manifest));
});

test("одинаковые законные строки без line ID не схлопываются", () => {
  const input = salesCase();
  input.manifest.sources[0].columnMappings = input.manifest.sources[0].columnMappings.filter((mapping) => mapping.targetField !== "sourceEventId");
  const sheet = input.workbooks[0].sheets[0];
  sheet.rows.push({ ...structuredClone(sheet.rows[1]), rowNumber: 3 });
  const result = normalizeSources(input.manifest, input.workbooks);
  assert.equal(result.report.acceptedRows, 2);
  assert.equal(result.normalizedDraft.rows.length, 2);
});

test("изменение семантики меняет идентичность manifest", async () => {
  const { importHash } = await import("../../lib/server/imports/service.ts");
  const changed = structuredClone(fixture.manifest);
  changed.forecastBasis = "monthly";
  assert.notEqual(importHash(fixture.manifest), importHash(changed));
  changed.forecastBasis = fixture.manifest.forecastBasis;
  changed.sources[0].semantics.operationType = "return";
  assert.notEqual(importHash(fixture.manifest), importHash(changed));
});
