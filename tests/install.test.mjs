import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { initializeHostingEnv, validateHostingEnvironment } from '../install.mjs';

test('Plesk initialization creates private live-only configuration and never rotates existing secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusa-installer-'));
  try {
    assert.equal(initializeHostingEnv(dir), true);
    const first = readFileSync(join(dir, '.env'), 'utf8'),
      env = parseEnv(first);
    assert.equal(env.APP_MODE, 'live');
    assert.equal(env.WORKER_MODE, 'opportunistic');
    assert.equal(Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64').length, 32);
    assert.equal(env.ADMIN_PASSWORD, undefined);
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    assert.equal(initializeHostingEnv(dir), false);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), first);
    assert.ok(validateHostingEnvironment(env, '22.12.0').length >= 3);
    const valid = {
      ...env,
      APP_ORIGIN: 'https://bot.example.org',
      DATABASE_URL: 'postgresql://user:password@database.example.org/cusa',
      CUSA_CLIENT_ID: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      CUSA_API_KEY: 'synthetic-key',
    };
    assert.deepEqual(validateHostingEnvironment(valid, '22.12.0'), []);
    for (const protocol of ['mysql', 'mariadb'])
      assert.deepEqual(
        validateHostingEnvironment({
          ...valid,
          DATABASE_URL: `${protocol}://user:password@localhost/cusa`,
        }),
        [],
      );
    for (const patch of [
      { APP_MODE: 'demo' },
      { APP_ORIGIN: 'http://bot.example.org' },
      { DATABASE_URL: 'sqlite://host/db' },
      { DATABASE_URL: 'mysql://user:password@host/' },
      { WORKER_MODE: 'cron' },
      { DATA_ENCRYPTION_KEY: 'bad' },
    ])
      assert.ok(validateHostingEnvironment({ ...valid, ...patch }).length > 0);
    assert.ok(validateHostingEnvironment(valid, '20.19.0').length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
