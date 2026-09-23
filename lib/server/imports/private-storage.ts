import "server-only"

import { S3Client } from "@aws-sdk/client-s3"
import type { Pool } from "pg"
import { createPrivateStorage } from "../storage"

export function createImportPrivateStorage(pool: Pool) {
  const bucket = process.env.S3_BUCKET
  const region = process.env.S3_REGION
  if (!bucket || !region) throw new Error("Хранилище не настроено")
  const client = new S3Client({
    region,
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    ...(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? {
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    } : {}),
  })
  return createPrivateStorage({
    client, bucket,
    authorizeProject: async ({ userId, projectId }) => {
      const result = await pool.query<{ archived_at: Date | null }>(
        "SELECT archived_at FROM projects WHERE id=$1 AND owner_user_id=$2", [projectId,userId])
      return !result.rows[0] ? null : result.rows[0].archived_at ? "archived" : "active"
    },
    resolveObject: async ({ userId, projectId, objectId }) => {
      const result = await pool.query<{
        id: string; project_id: string; purpose: "source" | "report" | "export"; object_key: string;
        content_type: string; byte_size: number; checksum: string
      }>(`SELECT s.* FROM source_objects s JOIN projects p ON p.id=s.project_id
        WHERE s.project_id=$1 AND s.id=$2 AND p.owner_user_id=$3`, [projectId,objectId,userId])
      const row = result.rows[0]
      return row ? { id: row.id, projectId: row.project_id, purpose: row.purpose,
        key: row.object_key, contentType: row.content_type, sizeBytes: row.byte_size,
        sha256Hex: row.checksum, confirmed: true } : null
    },
  })
}
