import assert from "node:assert/strict";
import { test } from "node:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../lib/server/db/schema";
import { withPostgres } from "../helpers/postgres";

test("Drizzle сохраняет порядок столбцов составных FK исполняемой миграции", async () => withPostgres(async (pool) => {
  const result = await pool.query<{
    table_name: string; foreign_table: string; local_columns: string[]; foreign_columns: string[];
  }>(`SELECT c.conrelid::regclass::text AS table_name, c.confrelid::regclass::text AS foreign_table,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS local_columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS foreign_columns
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE c.contype='f' AND n.nspname='public'`);
  const signature = (table: string, local: string[], target: string, foreign: string[]) =>
    JSON.stringify([table, local, target, foreign]);
  const actual = new Set(result.rows.map(row =>
    signature(row.table_name, row.local_columns, row.foreign_table, row.foreign_columns)));
  let checked = 0;
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const table = getTableConfig(value);
    for (const key of table.foreignKeys) {
      const reference = key.reference();
      const expected = signature(table.name, reference.columns.map(column => column.name),
        getTableConfig(reference.foreignTable).name, reference.foreignColumns.map(column => column.name));
      assert.ok(actual.has(expected), expected);
      checked++;
    }
  }
  assert.ok(checked >= 30, "Проверены связи всей модели, не только одна таблица");
}));
