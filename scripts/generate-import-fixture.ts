import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { ImportManifestSchema, type ImportManifest, type ImportObject } from "../lib/contracts/imports";

const projectId = "10000000-0000-4000-8000-000000000001";
const objectId = "20000000-0000-4000-8000-000000000001";
type SourceType = ImportManifest["sources"][number]["sourceType"];
type Field = ImportManifest["sources"][number]["columnMappings"][number]["targetField"];

/** Только вымышленные данные. Одинаковая предметная история, без данных партнёра. */
export async function createSyntheticImportFixture(): Promise<{ manifest: ImportManifest; objects: ImportObject[] }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Tessera synthetic fixture";
  workbook.created = new Date("2026-09-23T00:00:00Z");
  workbook.modified = new Date("2026-09-23T00:00:00Z");
  const sources: Record<string, unknown>[] = [];
  const add = (sourceType: SourceType, fields: Field[], rows: (string | number)[][]) => {
    const sheet = workbook.addWorksheet(sourceType);
    sheet.addRow(fields);
    for (const row of rows) sheet.addRow(row);
    sources.push({
      sourceObjectId: objectId, checksum: "0".repeat(64), sourceType,
      namespace: "synthetic", format: "generic", origin: "synthetic", sheet: sourceType,
      mappingVersion: "synthetic-v1", exportedAt: "2026-09-23T00:00:00Z",
      period: { startDate: "2025-01-01", endDate: "2026-09-23" }, unit: "pcs",
      completeness: "complete", confirmedByUserId: null, confirmationReason: null,
      columnMappings: fields.map((targetField) => ({ sourceColumn: targetField, targetField })),
      priority: 0, correctionReason: null, headerRow: 1,
      semantics: { operationType: "sale", growth: "rate", seasonality: "index", quantitySign: "preserve" },
    });
  };
  add("product_mapping", ["sku", "productName", "category", "unit", "supplierKey", "warehouseKey"],
    [["000123", "Синтетический кабель", "cable", "pcs", "supplier-a", "warehouse-a"]]);
  add("suppliers", ["supplierKey", "productName", "sku", "leadTimeDays", "moq", "packMultiple"],
    [["supplier-a", "Синтетический поставщик", "000123", "7", "1", "1"]]);
  add("lead_times", ["supplierKey", "sku", "leadTimeDays"], [["supplier-a", "000123", "7"]]);
  add("categories", ["sku", "category", "reviewPeriodDays", "safetyDays", "safetyStock"], [["000123", "cable", "30", "3", "0"]]);
  add("sales", ["sku", "warehouseKey", "date", "quantity", "unit", "sourceEventId", "anonymizedCustomerKey"],
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((date, index) =>
      ["000123", "warehouse-a", date, index === 3 ? "1000" : String(10 + index), "pcs", `sale-${index + 1}`, index === 3 ? "anon_outlier" : "anon_regular"]));
  add("monthly_sales", ["sku", "warehouseKey", "period", "quantity", "unit"],
    Array.from({ length: 12 }, (_, index) => ["000123", "warehouse-a", `2025-${String(index + 1).padStart(2, "0")}-01`, String(100 + index * 10), "pcs"]));
  add("stock", ["sku", "warehouseKey", "date", "stockQuantity", "unit"],
    [["000123", "warehouse-a", "2026-09-23", "0", "pcs"]]);
  add("inbound", ["sku", "warehouseKey", "supplierKey", "expectedDate", "inboundQuantity", "unit"],
    [["000123", "warehouse-a", "supplier-a", "2026-09-30", "25", "pcs"]]);
  add("stockouts", ["sku", "warehouseKey", "startDate", "endDate", "stockoutStatus"],
    [["000123", "warehouse-a", "2026-09-10", "2026-09-13", "observed"]]);
  add("growth", ["category", "growthFactor", "date"], [["cable", "0.1", "2026-09-23"]]);
  add("seasonality", ["sku", "period", "seasonalityIndex"],
    Array.from({ length: 12 }, (_, index) => ["000123", String(index + 1), index >= 5 && index <= 7 ? "1.2" : "1"]));
  add("material_statement", ["sku", "quantity", "unit", "warehouseKey"], [["000123", "5", "pcs", "warehouse-a"]]);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const manifest = ImportManifestSchema.parse({
    projectId, asOfDate: "2026-09-23", adapterVersion: "1", schemaVersion: "1", forecastBasis: "transactions",
    privacyPolicy: { version: "synthetic-only-v1", approvedByUserId: "synthetic_fixture_author", approvedAt: "2026-09-23T00:00:00Z" },
    sources: sources.map((source) => ({ ...source, checksum })),
  });
  return { manifest, objects: [{ id: objectId, bytes }] };
}

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) throw new Error("Укажите каталог синтетической фикстуры.");
  const fixture = await createSyntheticImportFixture();
  const directory = resolve(output);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "synthetic.xlsx"), fixture.objects[0].bytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "manifest.json"), JSON.stringify(fixture.manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Создана синтетическая фикстура. Это не данные партнёра.");
}
if (/(?:^|[/\\])generate-import-fixture\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch(() => { console.error("Не удалось создать фикстуру. Укажите новый доступный каталог."); process.exitCode = 1; });
}
