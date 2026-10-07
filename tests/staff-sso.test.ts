import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../server/config.js';
import { buildApp } from '../server/app.js';
import { openDatabase } from './database.js';
import { seed } from '../server/seed.js';
import { decrypt, tokenHash } from '../server/security.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cusa-staff-sso-'));
  const config = {
    ...getConfig({ APP_MODE: 'demo', DATA_DIR: root }),
    demo: false,
    origin: 'https://desk.example.org',
    ssoOrigin: 'https://sso.example.org',
    ssoClientId: randomUUID(),
    ssoApiKey: 'test-backend-key',
  };
  const db = await openDatabase({ memory: true });
  await seed(db, config);
  let sub: string = randomUUID(),
    roles = ['admin'],
    active = true,
    unavailable = false,
    aud: string = config.ssoClientId,
    exp = Math.floor(Date.now() / 1000) + 300,
    email = 'staff@example.org',
    exchanges = 0;
  const calls: { path: string; body: any }[] = [];
  const fetcher = (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    if (path.endsWith('/token')) {
      exchanges++;
      assert.equal(init.headers['X-API-Key'], config.ssoApiKey);
      assert.equal(body.client_id, undefined);
      assert.equal(body.redirect_uri, config.origin + '/api/auth/sso/callback');
      return Response.json({
        access_token: 'A'.repeat(43),
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'identity:read',
      });
    }
    const identity = {
      sub,
      aud,
      roles,
      scope: 'identity:read',
      email,
      email_verified: true,
      name: 'เจ้าหน้าที่ทดสอบ',
    };
    if (path.endsWith('/userinfo')) {
      assert.equal(init.headers.Authorization, 'Bearer ' + 'A'.repeat(43));
      return Response.json(identity);
    }
    if (path.endsWith('/introspect')) {
      assert.equal(init.headers['X-API-Key'], config.ssoApiKey);
      assert.deepEqual(body, { token: 'A'.repeat(43) });
      return unavailable
        ? Response.json({}, { status: 503 })
        : Response.json(active ? { ...identity, active: true, exp } : { active: false });
    }
    throw new Error('Unexpected network call');
  }) as typeof fetch;
  const app = await buildApp(db, config, { fetcher });
  const start = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sso/start',
      headers: { origin: config.origin },
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const url = new URL(response.json().url);
    return {
      response,
      url,
      callback:
        '/api/auth/sso/callback?state=' + url.searchParams.get('state') + '&code=' + 'B'.repeat(43),
      cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    };
  };
  const login = async () => {
    const flow = await start();
    const response = await app.inject({ url: flow.callback, headers: { cookie: flow.cookie } });
    const session = response.cookies.find((c) => c.name === 'cusa_session');
    return { response, cookie: session ? `${session.name}=${session.value}` : '', session };
  };
  return {
    root,
    config,
    db,
    app,
    start,
    login,
    calls,
    exchanges: () => exchanges,
    identity: () => ({ sub, roles, active, aud, exp }),
    change: (
      v: Partial<{
        sub: string;
        roles: string[];
        active: boolean;
        unavailable: boolean;
        aud: string;
        exp: number;
        email: string;
      }>,
    ) => {
      sub = v.sub ?? sub;
      roles = v.roles ?? roles;
      active = v.active ?? active;
      unavailable = v.unavailable ?? unavailable;
      aud = v.aud ?? aud;
      exp = v.exp ?? exp;
      email = v.email ?? email;
    },
    close: async () => {
      await app.close();
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('staff SSO uses browser-bound one-time PKCE and provisions a subject-bound account without a local password', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.db.query('SELECT id FROM agents')).length,
      0,
      'installation must not create an admin',
    );
    const deniedStart = await f.app.inject({
      method: 'POST',
      url: '/api/auth/sso/start',
      headers: { origin: 'https://foreign.example.org' },
      payload: {},
    });
    assert.equal(deniedStart.statusCode, 403);
    const flow = await f.start();
    assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
    const [tx] = await f.db.query('SELECT * FROM staff_sso_transactions WHERE state_hash=$1', [
      tokenHash(flow.url.searchParams.get('state')!),
    ]);
    assert.equal(
      flow.url.searchParams.get('code_challenge'),
      createHash('sha256').update(decrypt(tx.verifier, f.config.encryptionKey)).digest('base64url'),
    );
    assert.ok(flow.response.cookies[0].secure && flow.response.cookies[0].httpOnly);
    const wrong = await f.app.inject({
      url: flow.callback,
      headers: { cookie: 'cusa_staff_login=wrong' },
    });
    assert.equal(wrong.headers.location, '/admin?auth=invalid');
    assert.equal(f.exchanges(), 0);
    const response = await f.app.inject({ url: flow.callback, headers: { cookie: flow.cookie } });
    assert.equal(response.headers.location, '/admin/overview');
    const session = response.cookies.find((c) => c.name === 'cusa_session')!;
    assert.ok(session.maxAge! <= 300 && session.maxAge! > 0 && session.secure && session.httpOnly);
    const [account] = await f.db.query('SELECT * FROM agents');
    assert.equal(account.role, 'ADMIN');
    assert.equal(account.password_hash, '!SSO_ONLY');
    const [stored] = await f.db.query('SELECT * FROM staff_sso_sessions');
    assert.notEqual(stored.encrypted_token, 'A'.repeat(43));
    assert.equal(decrypt(stored.encrypted_token, f.config.encryptionKey), 'A'.repeat(43));
    assert.equal(
      (await f.app.inject({ url: flow.callback, headers: { cookie: flow.cookie } })).headers
        .location,
      '/admin?auth=invalid',
    );
    assert.equal(f.exchanges(), 1);
    const local = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: f.config.origin },
      payload: { email: account.email, password: 'anything' },
    });
    assert.equal(local.statusCode, 403);
    f.change({ email: 'changed@example.org' });
    assert.equal((await f.login()).response.headers.location, '/admin/overview');
    assert.equal(
      (await f.db.query('SELECT id FROM agents')).length,
      1,
      'changing email must not change identity',
    );
  } finally {
    await f.close();
  }
});

test('staff requests enforce current application roles, fail closed on outage, revocation and expiry', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login();
    const get = (url: string) => f.app.inject({ url, headers: { cookie } });
    assert.equal((await get('/api/settings')).statusCode, 200);
    f.change({ roles: ['agent'] });
    assert.equal((await get('/api/auth/me')).json().agent.role, 'AGENT');
    assert.equal((await get('/api/settings')).statusCode, 403);
    assert.equal((await get('/api/conversations')).statusCode, 200);
    f.change({ unavailable: true });
    assert.equal((await get('/api/conversations')).statusCode, 503);
    f.change({ unavailable: false, active: false });
    assert.equal((await get('/api/conversations')).statusCode, 401);
    assert.equal((await f.db.query('SELECT * FROM auth_sessions')).length, 0);
    f.change({ active: true, roles: ['reviewer'] });
    const next = await f.login();
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: { cookie: next.cookie } })).json().agent
        .role,
      'REVIEWER',
    );
    f.change({ exp: Math.floor(Date.now() / 1000) - 1 });
    assert.equal(
      (await f.app.inject({ url: '/api/conversations', headers: { cookie: next.cookie } }))
        .statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test('staff SSO denies member/global-admin roles and audience mismatch without creating staff', async () => {
  const f = await fixture();
  try {
    for (const roles of [['member'], ['ADMIN'], ['global_admin'], []]) {
      f.change({ roles });
      assert.equal((await f.login()).response.headers.location, '/admin?auth=denied');
    }
    f.change({ roles: ['admin'], aud: randomUUID() });
    assert.equal((await f.login()).response.headers.location, '/admin?auth=denied');
    assert.equal((await f.db.query('SELECT * FROM agents')).length, 0);
  } finally {
    await f.close();
  }
});

test('SSO cannot adopt a local account by email and disabled staff cannot sign in', async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "INSERT INTO agents(name,email,password_hash,role) VALUES('Legacy','staff@example.org','legacy','ADMIN')",
    );
    assert.equal((await f.login()).response.headers.location, '/admin?auth=conflict');
    assert.equal((await f.db.query('SELECT * FROM staff_identities')).length, 0);
    f.change({ email: 'another@example.org', roles: ['agent'] });
    const login = await f.login();
    assert.equal(login.response.headers.location, '/admin/overview');
    await f.db.query("UPDATE agents SET active=false WHERE email='another@example.org'");
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } })).statusCode,
      401,
    );
    assert.equal((await f.login()).response.headers.location, '/admin?auth=denied');
    const logout = await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: login.cookie, origin: f.config.origin },
      payload: {},
    });
    assert.equal(logout.statusCode, 200, 'expired/disabled sessions must still be able to log out');
  } finally {
    await f.close();
  }
});
