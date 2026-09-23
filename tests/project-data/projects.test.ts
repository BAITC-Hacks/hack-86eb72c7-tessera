import assert from "node:assert/strict";
import test from "node:test";
import { withPostgres } from "../helpers/postgres";
import { createProjectService } from "../../lib/server/projects";

test("PostgreSQL: владелец, имя, архив и отсутствие чужих наборов", async () => {
  await withPostgres(async (pool) => {
    const service = createProjectService(pool);
    const project = await service.create("owner-a", { name: "  Закупки  " });
    assert.equal(project.name, "Закупки");
    assert.equal(project.ownerUserId, "owner-a");
    await assert.rejects(service.get("owner-b", project.id));
    await assert.rejects(service.update("owner-b", project.id, { name: "Чужой" }));
    await assert.rejects(service.listDatasets("owner-b", project.id, {}));
    await assert.rejects(service.create("owner-a", { name: " " }));
    await assert.rejects(service.create("owner-a", { name: "x".repeat(121) }));
    await service.create("owner-a", { name: "Второй" });
    await service.create("owner-b", { name: "Чужой" });
    const first = await service.list("owner-a", { limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await service.list("owner-a", { limit: 1, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(second.nextCursor, null);
    await assert.rejects(service.list("owner-a", { limit: 101 }));
    await assert.rejects(service.create("owner-a", { name: "Подмена", ownerUserId: "owner-b" }));
    await service.update("owner-a", project.id, { archived: true });
    const stored = await pool.query("SELECT archived_at FROM projects WHERE id=$1", [project.id]);
    assert.ok(stored.rows[0].archived_at);
    assert.equal((await service.get("owner-a", project.id)).id, project.id);
  });
});
