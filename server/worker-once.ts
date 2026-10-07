import pg from 'pg';
import { getConfig } from './config.js';
import { openDatabase } from './db.js';
import { Worker } from './worker.js';

// Scheduled Task rescue worker for shared hosting when Passenger is idle.
const config = getConfig();
if (config.demo || !config.databaseUrl)
  throw new Error('Scheduled worker requires live PostgreSQL configuration');
const lock = new pg.Client({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 10000,
});
await lock.connect();
try {
  const {
    rows: [result],
  } = await lock.query('SELECT pg_try_advisory_lock(124995,2) AS acquired');
  if (result.acquired) {
    const db = await openDatabase({ ...config, migrate: false });
    try {
      const worker = new Worker(db, config);
      await worker.maintenance();
      const until = Date.now() + 25_000;
      let count = 0;
      while (Date.now() < until && count < 50 && (await worker.runOne())) count++;
      await db.query(
        `INSERT INTO settings(key,value,updated_at) VALUES('worker_heartbeat',$1,now()) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()`,
        [JSON.stringify({ at: new Date().toISOString(), jobs: count })],
      );
      console.log(`Scheduled worker completed: ${count} jobs`);
    } finally {
      await db.close();
    }
  } else console.log('Scheduled worker already running');
} finally {
  await lock.end();
}
