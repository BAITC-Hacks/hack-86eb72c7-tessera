import { open } from "node:fs/promises";
import { ImportManifestSchema, type ImportObject } from "../lib/contracts/imports";
import { validateImport } from "../lib/server/imports/service";

/** Ограничение проверяется до выделения буфера и после чтения открытого файла. */
async function readBoundedFile(path: string, limit: number): Promise<Uint8Array> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error("Удалённые адреса запрещены.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error("Недопустимый размер файла.");
    const buffer = new Uint8Array(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > stat.size) throw new Error("Файл изменился во время чтения.");
    return buffer.subarray(0, total);
  } finally { await file.close(); }
}

/** Локальный dry-run: не создаёт проект, не публикует набор и не отправляет файлы. */
export async function runImportCli(args: string[]): Promise<number> {
  if (args.length < 2 || args[0] !== "--manifest") {
    throw new Error("Использование: --manifest manifest.json UUID=local.xlsx ...");
  }
  const manifest = ImportManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(args[1], 1_048_576))));
  const requiredIds = new Set(manifest.sources.filter((source) => source.completeness === "complete").map((source) => source.sourceObjectId));
  const objects: ImportObject[] = [];
  const seen = new Set<string>();
  for (const argument of args.slice(2)) {
    const separator = argument.indexOf("=");
    const id = argument.slice(0, separator);
    const path = argument.slice(separator + 1);
    if (separator < 1 || !path || !requiredIds.has(id) || seen.has(id)) throw new Error("Некорректное сопоставление локальных файлов.");
    seen.add(id);
    objects.push({ id, bytes: await readBoundedFile(path, 26_214_400) });
  }
  if (objects.length !== requiredIds.size) throw new Error("Не передан обязательный файл.");
  const result = await validateImport(manifest, objects);
  // Не выводим исходные строки, значения ячеек или нормализованный черновик.
  console.log(JSON.stringify({ status: result.status, report: result.report }, null, 2));
  return result.status === "ready" ? 0 : 2;
}
if (/(?:^|[/\\])import-dataset\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
  runImportCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Импорт не выполнен: проверьте manifest, локальные файлы и лимиты. Исходные данные не выведены.");
    process.exitCode = 1;
  });
}
