import "server-only";

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fromBufferPromise } from "yauzl";
import type {
  ImportObject, ParsedCell, ParsedRow, ParsedSheet, ParsedWorkbook,
} from "@/lib/contracts/imports";

export const IMPORT_PARSER_LIMITS = Object.freeze({
  maxInputBytes: 25 * 1024 * 1024,
  maxEntries: 2048,
  maxEntryBytes: 96 * 1024 * 1024,
  maxInflatedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxSheets: 64,
  maxRows: 250_000,
  maxCells: 3_000_000,
  maxXmlDepth: 64,
});
export type ImportParserLimits = typeof IMPORT_PARSER_LIMITS;

export class ImportParserError extends Error {
  constructor(public readonly code: string) {
    super("Файл импорта отклонён: " + code);
    this.name = "ImportParserError";
  }
}
function fail(code: string): never { throw new ImportParserError(code); }
function hash(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return scalarText(record(value)["#text"]);
}
function scalarText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function richText(value: unknown): string {
  const node = record(value);
  return scalar(node.t) + list(node.r).map((run) => scalar(record(run).t)).join("");
}
function safePath(name: string) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") ||
      /^[a-z]:/i.test(name) || name.split("/").some((part) => part === ".." || part === ".")) {
    fail("UNSAFE_ARCHIVE_PATH");
  }
}
function xml(bytes: Buffer, limits: ImportParserLimits): Record<string, unknown> {
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("INVALID_XML_ENCODING"); }
  if (/<!DOCTYPE|<!ENTITY/i.test(content) || content.includes("\0")) fail("UNSAFE_XML");
  let depth = 0;
  // Bound nesting before invoking the tree parser; comments/declarations do not add depth.
  for (const match of content.matchAll(/<([^>]+)>/g)) {
    const tag = match[1];
    if (tag.startsWith("!") || tag.startsWith("?")) continue;
    if (tag.startsWith("/")) depth--;
    else if (!tag.endsWith("/")) depth++;
    if (depth > limits.maxXmlDepth) fail("XML_DEPTH_LIMIT");
  }
  if (XMLValidator.validate(content) !== true) fail("INVALID_XML");
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false,
    parseAttributeValue: false, trimValues: false, processEntities: true,
  });
  const parsed: unknown = parser.parse(content);
  return record(parsed);
}
async function unzip(bytes: Uint8Array, limits: ImportParserLimits) {
  const files = new Map<string, Buffer>();
  const zip = await fromBufferPromise(Buffer.from(bytes), {
    lazyEntries: true, validateEntrySizes: true, strictFileNames: true,
  });
  let total = 0;
  let count = 0;
  try {
    if (zip.entryCount > limits.maxEntries) fail("ARCHIVE_ENTRY_LIMIT");
    for await (const entry of zip.eachEntry()) {
      if (++count > limits.maxEntries) fail("ARCHIVE_ENTRY_LIMIT");
      safePath(entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) fail("ARCHIVE_SYMLINK");
      if (entry.isEncrypted()) fail("ENCRYPTED_ARCHIVE");
      if (/vbaproject|macrosheets|externallinks|embeddings|activex/i.test(entry.fileName)) fail("ACTIVE_CONTENT");
      if (files.has(entry.fileName)) fail("DUPLICATE_ARCHIVE_ENTRY");
      if (entry.uncompressedSize > limits.maxEntryBytes ||
          total + entry.uncompressedSize > limits.maxInflatedBytes) fail("ARCHIVE_SIZE_LIMIT");
      if (entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio) fail("ARCHIVE_RATIO_LIMIT");
      if (entry.fileName.endsWith("/")) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          total += data.length;
          if (size > limits.maxEntryBytes || total > limits.maxInflatedBytes ||
              size / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio) {
            fail("ARCHIVE_SIZE_LIMIT");
          }
          chunks.push(data);
        }
      } finally { stream.destroy(); }
      if (size !== entry.uncompressedSize) fail("ARCHIVE_SIZE_MISMATCH");
      files.set(entry.fileName, Buffer.concat(chunks, size));
    }
    return files;
  } finally { zip.close(); }
}
function columnNumber(address: string, rowNumber: number) {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(address);
  if (!match || Number(match[2]) !== rowNumber) fail("INVALID_CELL_ADDRESS");
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  if (column > 16384) fail("INVALID_CELL_ADDRESS");
  return column;
}
function cellValue(raw: Record<string, unknown>, shared: string[], rowNumber: number, formats: (string | undefined)[]): ParsedCell {
  const address = scalar(raw["@_r"]);
  const column = columnNumber(address, rowNumber);
  const tag = scalar(raw["@_t"]);
  const cached = Object.hasOwn(raw, "v") ? scalar(raw.v) : null;
  let type: ParsedCell["type"] = "number";
  let value: string | boolean | null = cached === "" ? null : cached;
  if (tag === "s") {
    if (cached === null || !/^(0|[1-9][0-9]*)$/.test(cached) || Number(cached) >= shared.length) fail("INVALID_SHARED_STRING");
    type = "string";
    value = shared[Number(cached)];
  } else if (tag === "inlineStr") { type = "string"; value = richText(raw.is); }
  else if (tag === "str") { type = "string"; value = cached; }
  else if (tag === "b") {
    if (cached !== "0" && cached !== "1") fail("INVALID_BOOLEAN_CELL");
    type = "boolean"; value = cached === "1";
  } else if (tag === "e") { type = "error"; }
  else if (tag === "d") { type = "date"; }
  else if (tag && tag !== "n") fail("UNSUPPORTED_CELL_TYPE");
  else if (value !== null && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value))) fail("INVALID_NUMBER_CELL");
  if (value === null && tag !== "e") type = "blank";
  const result: ParsedCell = { address, column, type, value };
  const style = scalar(raw["@_s"]);
  if (style) {
    if (!/^(0|[1-9][0-9]*)$/.test(style) || Number(style) >= formats.length) fail("INVALID_CELL_STYLE");
    result.numberFormat = formats[Number(style)];
  }
  if (tag === "e") result.error = cached ?? "EXCEL_ERROR";
  if (Object.hasOwn(raw, "f")) {
    result.formula = scalar(raw.f);
    // A missing or empty formula cache remains null; no evaluation is performed.
    result.type = "formula";
  }
  return result;
}

/** Разбирает только XLSX, без выполнения формул, записи на диск и сетевых запросов. */
export async function parseImportObject(
  object: ImportObject, overrides: Partial<ImportParserLimits> = {},
): Promise<ParsedWorkbook> {
  const limits = { ...IMPORT_PARSER_LIMITS, ...overrides };
  for (const key of Object.keys(IMPORT_PARSER_LIMITS) as (keyof ImportParserLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 ||
        limits[key] > IMPORT_PARSER_LIMITS[key]) fail("INVALID_PARSER_LIMIT");
  }
  if (!(object.bytes instanceof Uint8Array) || object.bytes.byteLength === 0) fail("EMPTY_FILE");
  if (object.bytes.byteLength > limits.maxInputBytes) fail("INPUT_SIZE_LIMIT");
  // Snapshot mutable caller buffers so the checksum describes the parsed bytes.
  const bytes = Buffer.from(object.bytes);
  try {
    const files = await unzip(bytes, limits);
    const getXml = (name: string) => {
      const bytes = files.get(name);
      if (!bytes) fail("MISSING_WORKBOOK_PART");
      return xml(bytes, limits);
    };
    // Inspect every relationship document, not just workbook relationships.
    for (const [name, bytes] of files) {
      if (name.endsWith(".rels")) {
        const relationships = record(xml(bytes, limits).Relationships);
        for (const raw of list(relationships.Relationship)) {
          const relation = record(raw);
          if (scalar(relation["@_TargetMode"]).toLowerCase() === "external") fail("EXTERNAL_RELATIONSHIP");
        }
      }
    }
    const contentTypes = getXml("[Content_Types].xml");
    if (/macroEnabled|vbaProject/i.test(JSON.stringify(contentTypes))) fail("ACTIVE_CONTENT");
    const workbook = record(getXml("xl/workbook.xml").workbook);
    const relations = new Map<string, string>();
    for (const item of list(record(getXml("xl/_rels/workbook.xml.rels").Relationships).Relationship)) {
      const relation = record(item);
      const target = scalar(relation["@_Target"]);
      const id = scalar(relation["@_Id"]);
      if (relations.has(id)) fail("DUPLICATE_RELATIONSHIP");
      if (!scalar(relation["@_Type"]).endsWith("/worksheet")) continue;
      safePath(target.startsWith("/") ? target.slice(1) : target);
      const part = target.startsWith("/") ? target.slice(1) : posix.join("xl", target);
      safePath(part);
      if (!part.startsWith("xl/worksheets/") || !part.endsWith(".xml")) fail("UNSAFE_WORKSHEET_PATH");
      relations.set(id, part);
    }
    const shared = files.has("xl/sharedStrings.xml")
      ? list(record(getXml("xl/sharedStrings.xml").sst).si).map(richText) : [];
    const styles = files.has("xl/styles.xml") ? record(getXml("xl/styles.xml").styleSheet) : {};
    const customFormats = new Map<string, string>();
    for (const value of list(record(styles.numFmts).numFmt)) {
      const format = record(value);
      customFormats.set(scalar(format["@_numFmtId"]), scalar(format["@_formatCode"]));
    }
    const builtinFormats: Record<string, string> = {
      "0": "General", "1": "0", "2": "0.00", "9": "0%", "10": "0.00%",
      "14": "mm-dd-yy", "15": "d-mmm-yy", "16": "d-mmm", "17": "mmm-yy",
      "18": "h:mm AM/PM", "19": "h:mm:ss AM/PM", "20": "h:mm",
      "21": "h:mm:ss", "22": "m/d/yy h:mm", "49": "@",
    };
    const formats = list(record(styles.cellXfs).xf).map((value) => {
      const id = scalar(record(value)["@_numFmtId"]);
      return customFormats.get(id) ?? builtinFormats[id];
    });
    const sheetNodes = list(record(workbook.sheets).sheet);
    if (!sheetNodes.length || sheetNodes.length > limits.maxSheets) fail("SHEET_LIMIT");
    const sheets: ParsedSheet[] = [];
    let rowCount = 0;
    let cellCount = 0;
    const names = new Set<string>();
    for (const raw of sheetNodes) {
      const info = record(raw);
      const name = scalar(info["@_name"]);
      if (!name || names.has(name)) fail("INVALID_SHEET_NAME");
      names.add(name);
      const part = relations.get(scalar(info["@_r:id"]));
      if (!part) fail("MISSING_WORKSHEET");
      const worksheet = record(getXml(part).worksheet);
      const rows: ParsedRow[] = [];
      let previous = 0;
      for (const value of list(record(worksheet.sheetData).row)) {
        if (++rowCount > limits.maxRows) fail("ROW_LIMIT");
        const row = record(value);
        const rowNumber = Number(scalar(row["@_r"]));
        if (!Number.isSafeInteger(rowNumber) || rowNumber <= previous || rowNumber > 1048576) fail("INVALID_ROW_NUMBER");
        previous = rowNumber;
        const cells: ParsedCell[] = [];
        const addresses = new Set<string>();
        for (const value of list(row.c)) {
          if (++cellCount > limits.maxCells) fail("CELL_LIMIT");
          const cell = cellValue(record(value), shared, rowNumber, formats);
          if (addresses.has(cell.address)) fail("DUPLICATE_CELL");
          addresses.add(cell.address);
          cells.push(cell);
        }
        rows.push({ rowNumber, cells });
      }
      sheets.push({ name, rows, hash: hash(files.get(part)!) });
    }
    const date1904 = scalar(record(workbook.workbookPr)["@_date1904"]);
    return {
      objectId: object.id, checksum: hash(bytes), sheets,
      dateSystem: date1904 === "1" || date1904 === "true" ? "1904" : "1900",
    };
  } catch (error) {
    if (error instanceof ImportParserError) throw error;
    // Third-party diagnostics may contain untrusted filenames or XML fragments.
    throw new ImportParserError("INVALID_XLSX");
  }
}
