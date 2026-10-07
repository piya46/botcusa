import { getConfig } from './config.js';
import { openDatabase } from './db.js';
import { seed } from './seed.js';
import { buildApp } from './app.js';
import { Worker } from './worker.js';
import { attachWorkerWakeup } from './runtime.js';
import { buildInstallApp, needsWebInstall } from './install.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (needsWebInstall(process.cwd(), process.env)) {
  const installer = await buildInstallApp({ root: process.cwd(), serveStatic: true });
  await installer.listen({
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3001),
  });
  console.log('Open /install. Installation access key: .setup/access.key (private file).');
  const closeInstaller = async () => {
    await installer.close();
    process.exit(0);
  };
  process.on('SIGINT', closeInstaller);
  process.on('SIGTERM', closeInstaller);
} else {
  if (
    (process.env.CUSA_PLESK_STARTUP === '1' || existsSync(resolve('.setup/completed'))) &&
    process.env.APP_MODE !== 'live'
  )
    throw new Error('Installed/Plesk application requires live configuration');
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
}
