import { Pool } from 'pg';
import { recoverCancelledRuns, recoverDispatch } from '../lib/server/dispatch';
import { triggerTransport } from '../lib/server/trigger-transport';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !process.env.TRIGGER_SECRET_KEY || !process.env.TRIGGER_PROJECT_REF) {
    throw new Error('DATABASE_URL, TRIGGER_SECRET_KEY и TRIGGER_PROJECT_REF обязательны');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const dispatch = await recoverDispatch(pool, triggerTransport);
    const cancellation = await recoverCancelledRuns(pool, triggerTransport);
    console.info(JSON.stringify({ dispatch, cancellation }));
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('dispatch_recovery_failed');
  process.exitCode = 1;
});
