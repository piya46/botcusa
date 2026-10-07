const { loadEnvFile, chdir } = require('node:process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
chdir(__dirname);
if (existsSync(join(__dirname, '.env'))) loadEnvFile(join(__dirname, '.env'));
if (process.env.APP_MODE !== 'live') throw new Error('Scheduled worker requires APP_MODE=live');
import('./dist-server/server/worker-once.js').catch(() => {
  console.error('Scheduled worker failed. Check PostgreSQL access and application configuration.');
  process.exitCode = 1;
});
