import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSyntheticImportFixture } from "../../scripts/generate-import-fixture.ts";
import { validateImport } from "../../lib/server/imports/service.ts";
import { commitDataset } from "../../lib/server/imports/commit.ts";
import { withPostgres } from "../helpers/postgres.ts";
import { createRepositories } from "../../lib/server/db/index.ts";

test("PostgreSQL: публикация атомарна, повтор идемпотентен, владелец и неизменность проверяются", async () => withPostgres(async (pool) => {
  const fixture = await createSyntheticImportFixture();
  const completeManifest = structuredClone(fixture.manifest);
  // Изолируем продажу: дополнительные роли проверяются полным XLSX E2E отдельно.
  fixture.manifest.sources = fixture.manifest.sources.filter((source) => source.sourceType === "sales");
  const repo = createRepositories(pool);
  const project = await repo.createProject("synthetic_owner", "Синтетический импорт");
  fixture.manifest.projectId = project.id;
  const object = fixture.objects[0];
  await repo.createSourceObject("synthetic_owner", { id: object.id, projectId: project.id,
    objectKey: `projects/${project.id}/sources/${object.id}`, checksum: fixture.manifest.sources[0].checksum,
    byteSize: object.bytes.length, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", purpose: "source" });
  const validated = await validateImport(fixture.manifest, fixture.objects);
  assert.equal(validated.status, "ready", JSON.stringify(validated.report));
  const draft = validated.normalizedDraft;
  const writeSnapshot = async (client, snapshot) => {
    await client.query("INSERT INTO suppliers(id,project_id,dataset_version_id,source_key,name) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), snapshot.projectId, snapshot.datasetVersionId, "synthetic:supplier", "Синтетический поставщик"]);
  };
  await assert.rejects(commitDataset(draft, {pool, userId: "other_owner", writeSnapshot}), /недоступен/);
  await assert.rejects(commitDataset(draft, {pool, userId: "synthetic_owner", writeSnapshot: async (...args) => {
    await writeSnapshot(...args); throw new Error("synthetic_rollback");
  }}), /synthetic_rollback/);
  assert.equal((await pool.query("SELECT count(*) FROM dataset_versions")).rows[0].count, "0");
  assert.equal((await pool.query("SELECT count(*) FROM suppliers")).rows[0].count, "0");
  const first = await commitDataset(draft, {pool, userId: "synthetic_owner", writeSnapshot});
  const second = await commitDataset(draft, {pool, userId: "synthetic_owner", writeSnapshot});
  assert.equal(second.id, first.id);
  assert.equal((await pool.query("SELECT count(*) FROM suppliers")).rows[0].count, "1");
  completeManifest.projectId = project.id;
  completeManifest.sources = completeManifest.sources.filter((source) => source.sourceType !== "material_statement");
  const full = await validateImport(completeManifest, fixture.objects);
  assert.equal(full.status, "ready", JSON.stringify(full.report));
  const persisted = await commitDataset(full.normalizedDraft, {pool, userId: "synthetic_owner"});
  assert.notEqual(persisted.id, first.id);
  assert.equal((await pool.query("SELECT count(*) FROM sales WHERE dataset_version_id=$1", [persisted.id])).rows[0].count, "4");
  assert.equal((await pool.query("SELECT sku FROM products WHERE dataset_version_id=$1", [persisted.id])).rows[0].sku, "000123");
  draft.rows[0].values.quantity = "999999";
  await assert.rejects(commitDataset(draft, {pool, userId: "synthetic_owner", writeSnapshot}), /изменён/);
}));
