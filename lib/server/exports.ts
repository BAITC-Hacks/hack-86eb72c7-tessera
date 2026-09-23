import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import type { PoolClient } from "pg";
import { canonicalDecimal, DatabaseAccessError, DatabaseConflictError } from "./db";
import { getPool } from "./db/pool";
import { createPrivateStorage, StorageError } from "./storage";

export const EXPORT_FORMAT_VERSION = "demo-csv-v1";
export const MAX_EXPORT_ROWS = 10_000;
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

type ExportLine = {
  id: string; supplier: string; sku: string; name: string; warehouse: string;
  quantity: string; unit: string; urgency: string; rationale: string;
};

/** Значения БД не меняются; защита применяется только к демонстрационному CSV. */
export function csvCell(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const safe = /^[\s]*[=+@-]/u.test(cleaned) ? `'${cleaned}` : cleaned;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function renderApprovalCsv(lines: ExportLine[]): Buffer {
  if (lines.length > MAX_EXPORT_ROWS) throw new RangeError("Превышен предел синхронного экспорта: 10000 строк.");
  const rows = ["Поставщик;Артикул;Наименование;Склад;Количество;Единица;Срочность;Обоснование"];
  const urgency: Record<string, string> = { urgent: "Срочно", planned: "Планово", none: "Нет", unknown: "Неизвестно" };
  for (const line of [...lines].sort((a, b) => a.supplier < b.supplier ? -1 : a.supplier > b.supplier ? 1 : a.id.localeCompare(b.id))) {
    const quantity = canonicalDecimal(line.quantity);
    if (!/^(?:0|[1-9]\d{0,21})(?:\.\d{1,8})?$/.test(quantity)) throw new DatabaseConflictError();
    if (quantity === "0") continue;
    rows.push([line.supplier, line.sku, line.name, line.warehouse, quantity, line.unit,
      urgency[line.urgency] ?? "Неизвестно", line.rationale].map(csvCell).join(";"));
  }
  if (rows.length === 1) throw new DatabaseConflictError();
  const body = Buffer.from(`\ufeff${rows.join("\r\n")}\r\n`, "utf8");
  if (body.byteLength > MAX_EXPORT_BYTES) throw new RangeError("Превышен предел синхронного экспорта: 10 МиБ.");
  return body;
}

async function currentApproval(client: PoolClient, userId: string, runId: string, approvalId: string) {
  const result = await client.query<{ project_id: string; review_version: number; lines_hash: string }>(`
    SELECT a.project_id,a.review_version,a.lines_hash FROM approvals a
    JOIN calculation_runs r ON r.id=a.run_id AND r.project_id=a.project_id
    JOIN projects p ON p.id=r.project_id
    WHERE a.id=$1 AND a.run_id=$2 AND p.owner_user_id=$3 AND p.archived_at IS NULL
      AND a.review_version=r.review_version FOR UPDATE OF r,p`, [approvalId, runId, userId]);
  if (!result.rowCount) {
    const owned = await client.query(`SELECT r.id FROM calculation_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1 AND p.owner_user_id=$2`, [runId, userId]);
    if (!owned.rowCount) throw new DatabaseAccessError();
    throw new DatabaseConflictError();
  }
  return result.rows[0];
}

/** Только текущая утверждённая редакция; файл не означает отправку поставщику. */
export async function exportApproval(userId: string, runId: string, approvalId: string) {
  const client = await getPool().connect();
  let locked = false;
  try {
    // Сериализация повторных экспортов без транзакции на время сетевого вызова.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`export:${approvalId}`]);
    locked = true;
    await client.query("BEGIN");
    const approval = await currentApproval(client, userId, runId, approvalId);
    const lines = await client.query<ExportLine>(`
      SELECT r.id,s.name AS supplier,p.sku,p.name,w.name AS warehouse,
        COALESCE(rv.reviewed_quantity,r.recommended_quantity)::text AS quantity,
        r.unit,r.urgency,r.rationale FROM recommendations r
      JOIN suppliers s ON s.id=r.supplier_id AND s.dataset_version_id=r.dataset_version_id AND s.project_id=r.project_id
      JOIN products p ON p.id=r.product_id AND p.dataset_version_id=r.dataset_version_id AND p.project_id=r.project_id
      JOIN warehouses w ON w.id=r.warehouse_id AND w.dataset_version_id=r.dataset_version_id AND w.project_id=r.project_id
      LEFT JOIN LATERAL (SELECT reviewed_quantity FROM recommendation_reviews
        WHERE recommendation_id=r.id AND review_version<=$2 ORDER BY review_version DESC LIMIT 1) rv ON true
      WHERE r.run_id=$1 ORDER BY r.id LIMIT 10001`, [runId, approval.review_version]);
    if (lines.rows.some(line => line.quantity === null)) throw new DatabaseConflictError();
    const hash = createHash("sha256").update(JSON.stringify(lines.rows.map(line => [line.id, canonicalDecimal(line.quantity)]))).digest("hex");
    if (hash !== approval.lines_hash) throw new DatabaseConflictError();
    const body = renderApprovalCsv(lines.rows);
    const checksum = createHash("sha256").update(body).digest("hex");
    const artifact = await client.query<{ checksum: string }>("SELECT checksum FROM export_artifacts WHERE approval_id=$1 AND format_version=$2", [approvalId, EXPORT_FORMAT_VERSION]);
    await client.query("COMMIT");
    if (artifact.rowCount && artifact.rows[0].checksum !== checksum) throw new DatabaseConflictError();
    if (!artifact.rowCount) {
      const bucket = process.env.S3_BUCKET;
      if (!bucket) throw new StorageError("STORAGE_UNAVAILABLE");
      const storage = createPrivateStorage({
        client: new S3Client({ region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT || undefined,
          credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          } : undefined }), bucket,
        authorizeProject: async ({ userId: owner, projectId }) => {
          const result = await client.query<{ archived_at: string | null }>("SELECT archived_at FROM projects WHERE id=$1 AND owner_user_id=$2", [projectId, owner]);
          return result.rowCount ? result.rows[0].archived_at ? "archived" : "active" : null;
        }, resolveObject: async () => null,
      });
      const object = await storage.upload({ userId, projectId: approval.project_id, purpose: "export", body, contentType: "text/csv", sha256Hex: checksum });
      await client.query("BEGIN");
      await currentApproval(client, userId, runId, approvalId);
      const source = await client.query<{ id: string }>(`INSERT INTO source_objects(id,project_id,object_key,checksum,byte_size,content_type,purpose)
        VALUES($1,$2,$3,$4,$5,'text/csv','export') ON CONFLICT(project_id,checksum) DO UPDATE SET checksum=EXCLUDED.checksum RETURNING id`,
      [object.id, approval.project_id, object.key, checksum, body.byteLength]);
      await client.query(`INSERT INTO export_artifacts(id,project_id,approval_id,source_object_id,checksum,format,format_version)
        VALUES($1,$2,$3,$4,$5,'csv',$6) ON CONFLICT(approval_id,format_version) DO NOTHING`,
      [randomUUID(), approval.project_id, approvalId, source.rows[0].id, checksum, EXPORT_FORMAT_VERSION]);
      await client.query("COMMIT");
    }
    // Повторная проверка после S3 или чтения уже существующего артефакта.
    await client.query("BEGIN");
    await currentApproval(client, userId, runId, approvalId);
    await client.query("COMMIT");
    return { body, filename: `demo-order-${approvalId}.csv`, contentType: "text/csv; charset=utf-8" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`export:${approvalId}`]);
    client.release();
  }
}
