import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { parse as dotenvParse } from 'dotenv';
import {
  buildInstallApp,
  dotenvText,
  needsWebInstall,
  type InstallDatabase,
} from '../server/install.js';
import type { InstallInput } from '../shared/install.js';

const input: InstallInput = {
  origin: 'https://bot.example.org',
  database: {
    host: 'localhost',
    port: 3306,
    name: 'cusa_test',
    user: 'test',
    password: 'DB@pass#with:/?%',
    tls: false,
    caFile: '',
  },
  services: {
    CUSA_SSO_ORIGIN: 'https://sso.example.org',
    CUSA_CLIENT_ID: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    CUSA_API_KEY: 'synthetic-sso-key',
    LINE_CHANNEL_SECRET: 'synthetic-secret',
    LINE_LOADING_ENABLED: 'true',
    LINE_LOADING_SECONDS: '30',
  },
};
const headers = { host: 'bot.example.org', origin: 'https://bot.example.org' };
async function fixture(
  database: InstallDatabase,
  initial?: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'cusa-web-install-'));
  if (initial) await writeFile(join(root, '.env'), initial, { mode: 0o600 });
  const app = await buildInstallApp({ root, database, environment });
  const key = await readFile(join(root, '.setup/access.key'), 'utf8');
  return {
    root,
    app,
    key,
    call: (route: string, body: unknown = input) =>
      app.inject({
        method: 'POST',
        url: '/api/install/' + route,
        headers: { ...headers, authorization: 'Bearer ' + key },
        payload: body as object,
      }),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('installer accepts group and room alert destinations while rejecting invalid IDs', async () => {
  const f = await fixture({
    inspect: async () => ({ version: '10.6.22-MariaDB', tables: 0 }),
    bootstrap: async () => {},
  });
  try {
    for (const prefix of ['C', 'U', 'R']) {
      const result = await f.call('check', {
        ...input,
        services: {
          ...input.services,
          LINE_AGENT_ALERT_USER_ID: prefix + 'a'.repeat(32),
          LINE_SUPERVISOR_ALERT_USER_ID: prefix + 'b'.repeat(32),
        },
      });
      assert.equal(result.statusCode, 200, result.body);
    }
    for (const value of ['@group', 'C123', 'c' + 'a'.repeat(32), 'https://line.me/group']) {
      const result = await f.call('check', {
        ...input,
        services: { ...input.services, LINE_AGENT_ALERT_USER_ID: value },
      });
      assert.equal(result.statusCode, 400, result.body);
    }
    const applied = await f.call('apply', {
      ...input,
      services: {
        ...input.services,
        LINE_AGENT_ALERT_USER_ID: 'C' + 'a'.repeat(32),
        LINE_SUPERVISOR_ALERT_USER_ID: 'R' + 'b'.repeat(32),
      },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const env = parseEnv(await readFile(join(f.root, '.env'), 'utf8'));
    assert.equal(env.LINE_AGENT_ALERT_USER_ID, 'C' + 'a'.repeat(32));
    assert.equal(env.LINE_SUPERVISOR_ALERT_USER_ID, 'R' + 'b'.repeat(32));
  } finally {
    await f.close();
  }
});

test('installer requires private key and same origin, hides secrets, and locks permanently on success', async () => {
  let bootstraps = 0;
  const encryptionKey = randomBytes(32).toString('base64');
  const initial = dotenvText({
    APP_MODE: 'live',
    APP_ORIGIN: 'https://your-domain.invalid',
    DATA_ENCRYPTION_KEY: encryptionKey,
  });
  const f = await fixture(
    {
      inspect: async () => ({ version: '10.6.22-MariaDB', tables: 0 }),
      bootstrap: async (env) => {
        bootstraps++;
        assert.equal(env.DATA_ENCRYPTION_KEY, encryptionKey);
        assert.equal(
          decodeURIComponent(new URL(env.DATABASE_URL).password),
          input.database.password,
        );
      },
    },
    initial,
  );
  try {
    assert.equal((await f.app.inject('/api/health')).statusCode, 503);
    assert.equal((await f.app.inject('/')).headers.location, '/install');
    const publicStatus = await f.app.inject('/api/install/status');
    assert.equal(publicStatus.headers['cache-control'], 'no-store');
    assert.deepEqual(publicStatus.json(), { installed: false, restartRequired: false });
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/install/apply', headers, payload: input }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/install/unlock',
          headers: {
            ...headers,
            origin: 'https://foreign.example.org',
            authorization: 'Bearer ' + f.key,
          },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal((await f.call('check')).statusCode, 200);
    assert.equal(bootstraps, 0, 'checking must not create tables');
    assert.equal(await readFile(join(f.root, '.env'), 'utf8'), initial);
    const result = await f.call('apply');
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(bootstraps, 1);
    assert.ok(!result.body.includes(input.services.CUSA_API_KEY));
    assert.ok(!result.body.includes(encryptionKey));
    const env = parseEnv(await readFile(join(f.root, '.env'), 'utf8'));
    assert.equal(env.APP_MODE, 'live');
    assert.equal(env.WORKER_MODE, 'opportunistic');
    assert.equal(env.ADMIN_PASSWORD, undefined);
    assert.equal(env.CUSA_API_KEY, input.services.CUSA_API_KEY);
    assert.equal(env.DATA_ENCRYPTION_KEY, encryptionKey);
    assert.equal((await stat(join(f.root, '.env'))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(f.root, '.setup/previous.env'), 'utf8'), initial);
    assert.equal(existsSync(join(f.root, '.setup/access.key')), false);
    assert.equal((await f.call('apply')).statusCode, 409);
    assert.equal(
      needsWebInstall(f.root, {}),
      false,
      'missing config must never reopen completed installer',
    );
  } finally {
    await f.close();
  }
});

test('installer refuses an existing database and rejects env injection without changing files', async () => {
  let bootstraps = 0;
  const f = await fixture({
    inspect: async () => ({ version: '8.4.0', tables: 2 }),
    bootstrap: async () => {
      bootstraps++;
    },
  });
  try {
    assert.equal((await f.call('check')).statusCode, 409);
    assert.equal((await f.call('apply')).statusCode, 409);
    assert.equal(
      (await f.call('apply', { ...input, services: { DATABASE_URL: 'malicious' } })).statusCode,
      400,
    );
    assert.equal(
      (
        await f.call('apply', {
          ...input,
          services: { ...input.services, CUSA_API_KEY: 'long-password\nAPP_MODE=demo' },
        })
      ).statusCode,
      400,
    );
    assert.equal(existsSync(join(f.root, '.env')), false);
    assert.equal(bootstraps, 0);
  } finally {
    await f.close();
  }
});

test('partial installation can resume with identical configuration and concurrent apply is rejected', async () => {
  let tables = 0,
    attempts = 0;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const f = await fixture({
    inspect: async () => ({ version: '8.4.0', tables }),
    bootstrap: async () => {
      attempts++;
      tables = 3;
      if (attempts === 1) throw new Error('synthetic provider error with secret');
      entered();
      await gate;
    },
  });
  try {
    const first = await f.call('apply');
    assert.equal(first.statusCode, 400);
    assert.ok(!first.body.includes('secret'));
    assert.equal(existsSync(join(f.root, '.env')), false);
    assert.equal(needsWebInstall(f.root, { APP_MODE: 'live' }), true);
    assert.equal(
      (
        await f.call('apply', {
          ...input,
          services: { ...input.services, CUSA_API_KEY: 'changed-key' },
        })
      ).statusCode,
      409,
    );
    const pending = f.call('apply');
    await started;
    assert.equal((await f.call('apply')).statusCode, 409);
    release();
    assert.equal((await pending).statusCode, 200);
    assert.equal(attempts, 2);
  } finally {
    release();
    await f.close();
  }
});

test('dotenv serialization preserves literal credentials in Node and dotenv and blocks newline injection', () => {
  for (const value of [
    'a#b c=d',
    'quote"and\\backslash',
    "single'and\\n",
    'with`backtick',
    'ไทย @#:/?%',
  ]) {
    const text = dotenvText({ TOKEN: value });
    assert.equal(parseEnv(text).TOKEN, value);
    assert.equal(dotenvParse(text).TOKEN, value);
  }
  assert.throws(() => dotenvText({ TOKEN: 'one\nAPP_MODE=demo' }));
});

test('installer preserves the existing local data key and detects conflicting Plesk variables', async () => {
  const f = await fixture({
    inspect: async () => ({ version: '8.4.0', tables: 0 }),
    bootstrap: async () => {},
  });
  const key = randomBytes(32);
  try {
    await mkdir(join(f.root, '.data'));
    await writeFile(join(f.root, '.data/encryption.key'), key, { mode: 0o600 });
    assert.equal((await f.call('apply')).statusCode, 200);
    assert.equal(
      parseEnv(await readFile(join(f.root, '.env'), 'utf8')).DATA_ENCRYPTION_KEY,
      key.toString('base64'),
    );
  } finally {
    await f.close();
  }
  const conflict = await fixture(
    {
      inspect: async () => {
        throw new Error('should not connect');
      },
      bootstrap: async () => {},
    },
    undefined,
    { DATABASE_URL: 'mysql://environment-conflict/db' },
  );
  try {
    assert.equal((await conflict.call('check')).statusCode, 409);
  } finally {
    await conflict.close();
  }
});

test('installer validates and persists LINE consent scopes independently of Provider matching', async () => {
  const f = await fixture({
    inspect: async () => ({ version: '10.6.22-MariaDB', tables: 0 }),
    bootstrap: async () => {},
  });
  try {
    const services = {
      ...input.services,
      CUSA_CLAIM_SCOPES: 'identity:read profile email line',
      CUSA_LINE_SAME_PROVIDER: 'false',
    };
    for (const bad of ['profile email line', 'identity:read unknown']) {
      const response = await f.call('check', {
        ...input,
        services: { ...services, CUSA_CLAIM_SCOPES: bad },
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    const response = await f.call('apply', { ...input, services });
    assert.equal(response.statusCode, 200, response.body);
    const env = parseEnv(await readFile(join(f.root, '.env'), 'utf8'));
    assert.equal(env.CUSA_CLAIM_SCOPES, services.CUSA_CLAIM_SCOPES);
    assert.equal(env.CUSA_LINE_SAME_PROVIDER, 'false');
  } finally {
    await f.close();
  }
});
