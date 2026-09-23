import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { createRunOwnershipLookup } from "../../lib/realtime/ownership";
import { withPostgres } from "../helpers/postgres";

async function addRun(pool: Pool, owner: string) {
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const importId = randomUUID();
  const datasetId = randomUUID();
  const runId = randomUUID();
  const checksum = "a".repeat(64);
  const manifestHash = "b".repeat(64);
  await pool.query("INSERT INTO projects(id, owner_user_id, name) VALUES($1,$2,$3)", [projectId, owner, "Тест"]);
  await pool.query(
    "INSERT INTO source_objects(id,project_id,object_key,checksum,byte_size,content_type,purpose) VALUES($1,$2,$3,$4,1,$5,'source')",
    [sourceId, projectId, `projects/${projectId}/sources/${sourceId}`, checksum, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  );
  await pool.query(
    "INSERT INTO imports(id,project_id,source_object_id,checksum,manifest,manifest_hash,adapter_version,schema_version,status) VALUES($1,$2,$3,$4,'[]'::jsonb,$5,'1','1','awaiting-validation')",
    [importId, projectId, sourceId, checksum, manifestHash],
  );
  await pool.query(
    "UPDATE imports SET status='validating', quality_report=$2::jsonb, state_version=state_version+1 WHERE id=$1",
    [importId, JSON.stringify({ checkedRows: 1, acceptedRows: 1, rejectedRows: 0, issues: [] })],
  );
  await pool.query(
    "INSERT INTO dataset_versions(id,project_id,import_id,manifest,manifest_hash,as_of_date,provenance,source_completeness,schema_version) VALUES($1,$2,$3,'[]'::jsonb,$4,'2026-09-23','synthetic','{}'::jsonb,'1')",
    [datasetId, projectId, importId, manifestHash],
  );
  await pool.query("UPDATE imports SET status='ready', dataset_version_id=$2, state_version=state_version+1 WHERE id=$1", [importId, datasetId]);
  await pool.query(
    "INSERT INTO calculation_runs(id,project_id,dataset_version_id,requested_by,scope,as_of_date,configuration,configuration_hash,request_hash,algorithm_version,idempotency_key,run_mode,status) VALUES($1,$2,$3,$4,'{}'::jsonb,'2026-09-23','{}'::jsonb,$5,$6,'1',$7,'diagnostic','queued')",
    [runId, projectId, datasetId, owner, "c".repeat(64), "d".repeat(64), runId],
  );
  return { projectId, runId };
}

test("Liveblocks ownership uses persisted run/project/owner and excludes archived projects", async () => {
  await withPostgres(async (pool) => {
    const first = await addRun(pool, "owner-one");
    const second = await addRun(pool, "owner-two");
    const owns = createRunOwnershipLookup(pool);
    assert.equal(await owns("owner-one", first.projectId, first.runId), true);
    assert.equal(await owns("owner-two", first.projectId, first.runId), false);
    assert.equal(await owns("owner-one", second.projectId, first.runId), false);
    assert.equal(await owns("owner-one", first.projectId, second.runId), false);
    await pool.query("UPDATE projects SET archived_at=now() WHERE id=$1", [first.projectId]);
    assert.equal(await owns("owner-one", first.projectId, first.runId), false);
  });
});
