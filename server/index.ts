import { getConfig } from './config.js';
import { openDatabase } from './db.js';
import { seed } from './seed.js';
import { buildApp } from './app.js';
import { Worker } from './worker.js';
import { attachWorkerWakeup } from './runtime.js';

const config = getConfig();
const db = await openDatabase(config);
await seed(db, config);
const app = await buildApp(db, config, { serveStatic: true, logger: true });
const worker = new Worker(db, config);
attachWorkerWakeup(app, worker);
await app.listen({ host: config.host, port: config.port });
worker.start();
app.log.info(
  { mode: config.demo ? 'DEMO — simulated LINE delivery' : 'LIVE' },
  'CUSA Member Desk ready',
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await worker.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
