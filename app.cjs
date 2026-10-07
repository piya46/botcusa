// Plesk / Passenger startup file. Keep the application root outside the public document root.
const { loadEnvFile, chdir } = require('node:process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
chdir(__dirname);
if (existsSync(join(__dirname, '.env'))) loadEnvFile(join(__dirname, '.env'));
if (process.env.APP_MODE !== 'live') throw new Error('Plesk startup requires APP_MODE=live');
// Passenger automatically intercepts the HTTP server listen call; no public custom port is needed.
import('./dist-server/server/index.js').catch(() => {
  console.error('CUSA startup failed. Check Node version, .env and database access.');
  process.exitCode = 1;
});
