import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyMigrations } from "../../lib/server/db/migrate";
import { withPostgres } from "../helpers/postgres";

test("миграции сериализуются, проверяют checksum и откатываются целиком", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tessera-migrations-"));
  try {
    await writeFile(join(directory, "0000_data_model.sql"), await readFile("drizzle/0000_data_model.sql"));
    const next = join(directory, "0001_concurrency_probe.sql");
    const sql = "CREATE TABLE migration_probe (id integer PRIMARY KEY);";
    await writeFile(next, sql);
    await withPostgres(async (pool) => {
      await Promise.all([applyMigrations(pool, directory), applyMigrations(pool, directory)]);
      const applied = await pool.query("SELECT count(*) FROM schema_migrations WHERE name=$1", ["0001_concurrency_probe.sql"]);
      assert.equal(applied.rows[0].count, "1");

      await writeFile(next, `${sql}\n-- изменённая применённая миграция`);
      await assert.rejects(applyMigrations(pool, directory), /checksum changed/);
      await writeFile(next, sql);

      await writeFile(join(directory, "0002_failed_probe.sql"),
        "CREATE TABLE must_rollback (id integer); SELECT * FROM missing_migration_table;");
      await assert.rejects(applyMigrations(pool, directory));
      assert.equal((await pool.query("SELECT to_regclass('public.must_rollback') AS name")).rows[0].name, null);
      assert.equal((await pool.query("SELECT count(*) FROM schema_migrations WHERE name=$1", ["0002_failed_probe.sql"])).rows[0].count, "0");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
