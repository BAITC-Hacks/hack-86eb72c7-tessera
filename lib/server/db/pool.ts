import "server-only";
import { Pool } from "pg";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("База данных временно недоступна.");
  pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  // A failed idle connection must not crash the server or log connection secrets.
  pool.on("error", () => {});
  return pool;
}

// Совместимый контракт API проектов из main; используется тот же пул.
export const getProjectDataPool = getPool;
