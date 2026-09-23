import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { parseImportObject, ImportParserError } from "../../lib/server/imports/parser.ts";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Small independent fixture encoder also permits intentionally unsafe ZIP metadata.
function zip(entries, { compress = false, symlink = false, encrypted = false } = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(text);
    const data = compress ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(encrypted ? 1 : 0, 6);
    header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE((3 << 8) | 20, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE(symlink ? (0o120777 << 16) >>> 0 : 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function parts(rows, extra = []) {
  return [
    ["[Content_Types].xml", '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
    ["xl/workbook.xml", '<workbook><workbookPr date1904="1"/><sheets><sheet name="Продажи" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", '<worksheet><sheetData>' + rows + '</sheetData></worksheet>'],
    ...extra,
  ];
}
const parse = (entries, limits, options) => parseImportObject({ id: "synthetic", bytes: zip(entries, options) }, limits);
const rejects = (entries, code, limits, options) => assert.rejects(parse(entries, limits, options),
  (error) => error instanceof ImportParserError && (!code || error.code === code));

test("preserves codes, exact decimal strings, negatives, errors, zero and missing formula caches", async () => {
  const result = await parse(parts('<row r="1">' +
    '<c r="A1" t="inlineStr"><is><t>00012</t></is></c>' +
    '<c r="B1"><v>9007199254740993.12345678</v></c>' +
    '<c r="C1"><v>-2.5</v></c><c r="D1"><v>0</v></c>' +
    '<c r="E1" t="e"><v>#N/A</v></c>' +
    '<c r="F1"><f>1+1</f></c><c r="G1"><f>0+0</f><v>0</v></c>' +
    '<c r="H1"/><c r="I1"><f>1/0</f><v/></c>' +
    '<c r="J1" t="b"><v>1</v></c></row>'));
  const cells = result.sheets[0].rows[0].cells;
  assert.deepEqual(cells.map((cell) => cell.value),
    ["00012", "9007199254740993.12345678", "-2.5", "0", "#N/A", null, "0", null, null, true]);
  assert.equal(cells[4].error, "#N/A");
  assert.equal(cells[5].type, "formula");
  assert.equal(cells[7].type, "blank");
  assert.equal(result.dateSystem, "1904");
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.equal(result.sheets[0].name, "Продажи");
});

test("reads actual ExcelJS synthetic XLSX and shared/rich text without evaluation", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Синтетика");
  sheet.addRow(["0007", 12, { formula: "SUM(B1)", result: 12 }]);
  sheet.getCell("B1").numFmt = "000000";
  sheet.getCell("A2").value = { richText: [{ text: "A & " }, { text: "B" }] };
  const bytes = await workbook.xlsx.writeBuffer();
  const result = await parseImportObject({ id: "exceljs", bytes });
  assert.equal(result.sheets[0].rows[0].cells[0].value, "0007");
  assert.equal(result.sheets[0].rows[0].cells[1].numberFormat, "000000");
  assert.equal(result.sheets[0].rows[0].cells[2].formula, "SUM(B1)");
  assert.equal(result.sheets[0].rows[1].cells[0].value, "A & B");
});

test("rejects oversized input, entry count, inflated entry/total and compression ratio", async () => {
  const fixture = parts('<row r="1"><c r="A1"><v>1</v></c></row>');
  await rejects(fixture, "INPUT_SIZE_LIMIT", { maxInputBytes: 1 });
  await rejects(fixture, "ARCHIVE_ENTRY_LIMIT", { maxEntries: 1 });
  await rejects(fixture, "ARCHIVE_SIZE_LIMIT", { maxEntryBytes: 10 });
  await rejects(fixture, "ARCHIVE_SIZE_LIMIT", { maxInflatedBytes: 100 });
  await rejects(parts("", [["xl/bomb.xml", "a".repeat(100000)]]), "ARCHIVE_RATIO_LIMIT", undefined, { compress: true });
});

test("rejects unsafe paths, symlinks, duplicate entries and encrypted archives", async () => {
  await rejects(parts("", [["../secret", "x"]]));
  await rejects(parts("", [["x\\y", "x"]]));
  await rejects(parts(""), "ARCHIVE_SYMLINK", undefined, { symlink: true });
  await rejects(parts("", [["xl/workbook.xml", "duplicate"]]), "DUPLICATE_ARCHIVE_ENTRY");
  await rejects(parts(""), undefined, undefined, { encrypted: true });
});

test("rejects macros, external relationships, DTDs and malformed XML", async () => {
  await rejects(parts("", [["xl/vbaProject.bin", "x"]]), "ACTIVE_CONTENT");
  await rejects(parts("", [["xl/worksheets/_rels/sheet1.xml.rels",
    '<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>']]), "EXTERNAL_RELATIONSHIP");
  const dtd = parts("");
  dtd[1][1] = '<!DOCTYPE workbook [<!ENTITY x "secret">]><workbook/>';
  await rejects(dtd, "UNSAFE_XML");
  const broken = parts("");
  broken[1][1] = "<workbook>";
  await rejects(broken, "INVALID_XML");
});

test("rejects excessive nesting, rows, cells, duplicate cells and invalid shared references", async () => {
  await rejects(parts('<row r="1"><c r="A1"><v>1</v></c></row>'), "XML_DEPTH_LIMIT", { maxXmlDepth: 2 });
  await rejects(parts('<row r="1"/><row r="2"/>'), "ROW_LIMIT", { maxRows: 1 });
  await rejects(parts('<row r="1"><c r="A1"/><c r="B1"/></row>'), "CELL_LIMIT", { maxCells: 1 });
  await rejects(parts('<row r="1"><c r="A1"/><c r="A1"/></row>'), "DUPLICATE_CELL");
  await rejects(parts('<row r="1"><c r="A1" t="s"><v>99</v></c></row>'), "INVALID_SHARED_STRING");
});

test("rejects non-XLSX safely, does not leak filenames, and cannot relax security limits", async () => {
  await assert.rejects(parseImportObject({ id: "x", bytes: Buffer.from("not zip") }),
    (error) => error.code === "INVALID_XLSX" && !error.message.includes("not zip"));
  await rejects(parts(""), "INVALID_PARSER_LIMIT", { maxInputBytes: Number.MAX_SAFE_INTEGER });
  await rejects([["private customer name", "raw value"]], "MISSING_WORKBOOK_PART");
});

test("rejects forged inflated sizes and duplicate row coordinates", async () => {
  const bytes = zip(parts('<row r="1"><c r="A1"><v>1</v></c></row>'), { compress: true });
  let cursor = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  // Lie about the first central-directory entry's inflated size.
  bytes.writeUInt32LE(1, cursor + 24);
  await assert.rejects(parseImportObject({ id: "forged", bytes }), ImportParserError);
  await rejects(parts('<row r="1"/><row r="1"/>'), "INVALID_ROW_NUMBER");
});

test("rejects missing selected worksheet and invalid actual numeric cells", async () => {
  const entries = parts("");
  entries.pop();
  await rejects(entries, "MISSING_WORKBOOK_PART");
  await rejects(parts('<row r="1"><c r="A1"><v>not a number</v></c></row>'), "INVALID_NUMBER_CELL");
  await rejects(parts('<row r="1"><c r="A2"><v>1</v></c></row>'), "INVALID_CELL_ADDRESS");
});

test("enforces the real input byte ceiling and snapshots mutable input", async () => {
  await assert.rejects(parseImportObject({ id: "large", bytes: Buffer.alloc(25 * 1024 * 1024 + 1) }),
    (error) => error.code === "INPUT_SIZE_LIMIT");
  const bytes = zip(parts('<row r="1"><c r="A1"><v>5</v></c></row>'));
  const baseline = await parseImportObject({ id: "baseline", bytes });
  const pending = parseImportObject({ id: "mutable", bytes });
  bytes.fill(0);
  const result = await pending;
  assert.equal(result.checksum, baseline.checksum);
  assert.equal(result.sheets[0].rows[0].cells[0].value, "5");
});
