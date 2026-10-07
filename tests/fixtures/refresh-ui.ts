// Isolated browser fixture. Never starts via production entrypoints or connects to real providers.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db.js';
import { seed, DEMO_AGENTS } from '../../server/seed.js';
import { buildApp } from '../../server/app.js';
import { encrypt, newToken, tokenHash } from '../../server/security.js';

const metadata = process.env.REFRESH_UI_FIXTURE;
if (!metadata || !metadata.startsWith('/tmp/cusa-refresh-'))
  throw new Error('Explicit disposable fixture path required');
const root = await mkdtemp(join(tmpdir(), 'cusa-refresh-ui-'));
const demo = getConfig({ APP_MODE: 'demo', DATA_DIR: root });
const config = {
  ...demo,
  demo: false,
  origin: 'https://desk.example.org',
  ssoOrigin: 'https://sso.example.org',
  ssoClientId: randomUUID(),
  ssoApiKey: 'synthetic-key',
};
const db = await openDatabase({ memory: true });
await seed(db, demo);
const cookie = newToken(),
  hash = tokenHash(cookie),
  sub = randomUUID();
const deadline = new Date(Date.now() + 8 * 3600000);
await db.query('INSERT INTO staff_identities(cusa_sub,application_id,agent_id) VALUES($1,$2,$3)', [
  sub,
  config.ssoClientId,
  DEMO_AGENTS[0].id,
]);
await db.query('INSERT INTO auth_sessions(token_hash,agent_id,expires_at) VALUES($1,$2,$3)', [
  hash,
  DEMO_AGENTS[0].id,
  deadline,
]);
await db.query(
  'INSERT INTO staff_sso_sessions(token_hash,cusa_sub,encrypted_token) VALUES($1,$2,$3)',
  [hash, sub, encrypt('A'.repeat(43), config.encryptionKey)],
);
await db.query(
  `INSERT INTO staff_sso_refresh(token_hash,encrypted_refresh_token,access_expires_at,refresh_expires_at,api_key_hash,scopes) VALUES($1,$2,$3,$4,$5,$6)`,
  [
    hash,
    encrypt('a'.repeat(43), config.encryptionKey),
    new Date(Date.now() + 300000),
    deadline,
    tokenHash(config.ssoApiKey),
    'identity:read',
  ],
);
let rotations = 0,
  roles = ['admin'];
const app = await buildApp(db, config, {
  serveStatic: true,
  fetcher: (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/token')) {
      assert.deepEqual(body, { grant_type: 'refresh_token', refresh_token: 'a'.repeat(43) });
      rotations++;
      return Response.json({
        token_type: 'Bearer',
        access_token: 'B'.repeat(43),
        expires_in: 300,
        refresh_token: 'b'.repeat(43),
        refresh_expires_in: 28000,
        scope: 'identity:read',
      });
    }
    if (String(url).endsWith('/introspect'))
      return Response.json({
        active: true,
        sub,
        aud: config.ssoClientId,
        roles,
        scope: 'identity:read',
        exp: Math.floor(Date.now() / 1000) + 300,
      });
    throw new Error('Unexpected provider request');
  }) as typeof fetch,
});
app.post('/test/expire-access', async () => {
  await db.query('UPDATE staff_sso_refresh SET access_expires_at=$2 WHERE token_hash=$1', [
    hash,
    new Date(Date.now() - 1000),
  ]);
  return { ok: true };
});
app.post('/test/remove-role', async () => {
  roles = ['member'];
  return { ok: true };
});
app.get('/test/status', async () => ({ rotations }));
const [conversation] = await db.query(
  "SELECT id FROM conversations WHERE status='AGENT_IN_CHARGE' AND assigned_agent_id=$1 LIMIT 1",
  [DEMO_AGENTS[0].id],
);
await app.listen({ host: '127.0.0.1', port: 33184 });
await writeFile(metadata, JSON.stringify({ pid: process.pid, cookie, caseId: conversation.id }), {
  mode: 0o600,
});
console.log('Synthetic refresh browser fixture ready on 33184');
process.on('SIGTERM', async () => {
  await app.close();
  await db.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
});
