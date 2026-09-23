import { Pool } from "pg";
import { applyMigrations } from "../lib/server/db/migrate";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL не задан.");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await applyMigrations(pool);
    console.log("Миграции модели данных применены.");
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // Ошибки драйвера могут содержать адрес сервера и исходные данные.
  console.error("Не удалось применить миграции. Проверьте серверную конфигурацию и версию схемы.");
  process.exitCode = 1;
});
