import assert from "node:assert/strict";
import test from "node:test";
import { withPostgres } from "../helpers/postgres";
import { createProjectService } from "../../lib/server/projects";
import { createImportLifecycle } from "../../lib/server/imports/lifecycle";
import { createSyntheticImportFixture } from "../../scripts/generate-import-fixture";

test("PostgreSQL: finalize повторяем, manifest неизменяем, новая попытка не создаёт набор", async () => {
  await withPostgres(async pool => {
    const projects = createProjectService(pool);
    const project = await projects.create("owner-a", {name:"Импорт"});
    const fixture = await createSyntheticImportFixture();
    const checksum = fixture.manifest.sources[0].checksum!;
    const size = fixture.objects[0].bytes.byteLength;
    const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    let headChecksum = checksum;
    const imports = createImportLifecycle({pool, storage:{
      signUpload: async () => ({url:"https://private.invalid/upload",method:"PUT" as const,headers:{"content-type":contentType,"content-length":String(size),"if-none-match":"*","x-amz-checksum-sha256":Buffer.from(checksum,"hex").toString("base64"),"x-amz-meta-sha256-hex":checksum,"x-amz-meta-project-id":project.id,"x-amz-meta-purpose":"source"},expiresAt:"2026-09-23T12:00:00Z"}),
      head: async () => ({sizeBytes:size,contentType,checksum:headChecksum,checksumPending:false}),
    }});
    const input = {fileName:"synthetic.xlsx",size,contentType,checksum,sourceRole:"sales"};
    await assert.rejects(imports.create("owner-b",project.id,input));
    const created = await imports.create("owner-a",project.id,input);
    fixture.manifest.projectId = project.id;
    fixture.manifest.sources = fixture.manifest.sources.map(source => ({...source,sourceObjectId:created.sourceObjectId}));
    headChecksum = "0".repeat(64);
    await assert.rejects(imports.finalize("owner-a",project.id,created.importId,{manifest:fixture.manifest}));
    headChecksum = checksum;
    const finalized = await imports.finalize("owner-a",project.id,created.importId,{manifest:fixture.manifest});
    assert.equal(finalized.status,"awaiting-validation");
    assert.equal(finalized.validationPending,true);
    assert.equal(finalized.report,null);
    assert.deepEqual(await imports.finalize("owner-a",project.id,created.importId,{manifest:fixture.manifest}),finalized);
    const changed = {...fixture.manifest,adapterVersion:"new-attempt"};
    await assert.rejects(imports.finalize("owner-a",project.id,created.importId,{manifest:changed}));
    const attempt = await imports.attempt("owner-a",project.id,created.importId,{manifest:changed});
    assert.notEqual(attempt.importId,created.importId);
    assert.equal(attempt.status,"uploaded");
    assert.equal((await imports.attempt("owner-a",project.id,created.importId,{manifest:changed})).importId,attempt.importId);
    await assert.rejects(imports.get("owner-b",project.id,created.importId));
    assert.equal((await pool.query("SELECT count(*)::int n FROM dataset_versions")).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM dispatch_intents")).rows[0].n,0);
    await projects.update("owner-a",project.id,{archived:true});
    await assert.rejects(imports.attempt("owner-a",project.id,created.importId,{manifest:changed}));
  });
});
