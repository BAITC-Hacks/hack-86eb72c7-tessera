import 'server-only';
import { Pool } from 'pg';
import { ProjectDataError } from '../project-data-errors';

let pool: Pool | undefined;
export function getProjectDataPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new ProjectDataError(503, 'database_unavailable', 'Хранилище временно недоступно');
    pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    pool.on('error', () => { /* Ошибки простаивающих соединений не раскрывают секреты. */ });
  }
  return pool;
}
