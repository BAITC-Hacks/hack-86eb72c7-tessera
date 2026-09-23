import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { applyMigrations } from '../../lib/server/db/migrate';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port unavailable');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function withPostgres<T>(run: (pool: Pool) => Promise<T>, options: { migrate?: boolean } = {}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-pg-'));
  const port = await freePort();
  const database = new EmbeddedPostgres({ databaseDir: join(dir, 'db'), port, user: 'postgres', password: 'test', persistent: false, onLog: () => {}, onError: () => {} });
  let started = false;
  let pool: Pool | undefined;
  try {
    await database.initialise();
    await database.start();
    started = true;
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password: 'test', database: 'postgres' });
    if (options.migrate !== false) await applyMigrations(pool);
    return await run(pool);
  } finally {
    await pool?.end();
    if (started) await database.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
