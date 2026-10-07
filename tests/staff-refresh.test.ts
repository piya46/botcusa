import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../server/config.js';
import { buildApp } from '../server/app.js';
import { openDatabase, type Database } from './database.js';
import { seed } from '../server/seed.js';
import { decrypt, tokenHash } from '../server/security.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cusa-refresh-'));
  const config = {
    ...getConfig({ APP_MODE: 'demo', DATA_DIR: root }),
    demo: false,
    origin: 'https://desk.example.org',
    ssoOrigin: 'https://sso.example.org',
    ssoClientId: randomUUID(),
    ssoApiKey: 'synthetic-api-key',
  };
  const db = await openDatabase({ memory: true });
  await seed(db, config);
  let sub: string = randomUUID(),
    aud: string = config.ssoClientId,
    roles = ['admin'],
    active = true;
  let refreshSeconds = 36000,
    rotations = 0,
    revision = 0,
    failedRevoke = false;
  let hold: (() => Promise<void>) | undefined,
    tokenFailure:
      'network' | '500' | '429' | 'malformed' | 'reuse' | 'scope' | 'invalid' | undefined;
  let introspectionHold: ((token: string) => Promise<void>) | undefined;
  const revoked: string[] = [];
  const access = () => String.fromCharCode(65 + revision).repeat(43);
  const refresh = () => String.fromCharCode(97 + revision).repeat(43);
  const identity = () => ({ sub, aud, roles, scope: 'identity:read profile', name: 'Staff' });
  const result = () => ({
    access_token: access(),
    token_type: 'Bearer',
    expires_in: 300,
    scope: 'identity:read profile',
    refresh_token: refresh(),
    refresh_expires_in: refreshSeconds,
  });
  const fetcher = (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    const body = init.body && JSON.parse(init.body);
    if (path.endsWith('/token')) {
      assert.equal(init.headers['X-API-Key'], config.ssoApiKey);
      if (body.grant_type === 'authorization_code') {
        assert.equal(body.request_refresh_token, true);
        assert.equal(body.client_id, undefined);
        assert.equal(body.redirect_uri, config.origin + '/api/auth/sso/callback');
        return Response.json(result());
      }
      assert.deepEqual(body, { grant_type: 'refresh_token', refresh_token: refresh() });
      rotations++;
      revision++;
      if (hold) await hold();
      if (tokenFailure === 'network')
        throw new Error('provider error containing ' + body.refresh_token);
      if (tokenFailure === '500' || tokenFailure === '429' || tokenFailure === 'invalid')
        return Response.json(
          { code: 'invalid_grant' },
          { status: tokenFailure === 'invalid' ? 400 : Number(tokenFailure) },
        );
      if (tokenFailure === 'malformed')
        return Response.json({ ...result(), refresh_token: undefined });
      if (tokenFailure === 'reuse')
        return Response.json({ ...result(), refresh_token: body.refresh_token });
      if (tokenFailure === 'scope')
        return Response.json({ ...result(), scope: 'identity:read profile phone' });
      return Response.json(result());
    }
    if (path.endsWith('/userinfo')) return Response.json(identity());
    if (path.endsWith('/introspect')) {
      await introspectionHold?.(body.token);
      return Response.json(
        active && body.token === access()
          ? { ...identity(), active: true, exp: Math.floor(Date.now() / 1000) + 300 }
          : { active: false },
      );
    }
    if (path.endsWith('/revoke')) {
      revoked.push(body.token);
      return failedRevoke ? Response.json({}, { status: 503 }) : Response.json({ ok: true });
    }
    throw new Error('Unexpected provider URL');
  }) as typeof fetch;
  const app = await buildApp(db, config, { fetcher });
  const apps = [app];
  const anotherApp = async (database: Database = db) => {
    const other = await buildApp(database, config, { fetcher });
    apps.push(other);
    return other;
  };
  const login = async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/auth/sso/start',
      headers: { origin: config.origin },
      payload: {},
    });
    const state = new URL(started.json().url).searchParams.get('state');
    const response = await app.inject({
      url: `/api/auth/sso/callback?state=${state}&code=${'X'.repeat(43)}`,
      headers: { cookie: started.cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    assert.equal(response.headers.location, '/admin/overview', response.body);
    const session = response.cookies.find((c) => c.name === 'cusa_session')!;
    return {
      cookie: `${session.name}=${session.value}`,
      hash: tokenHash(session.value),
      response,
      session,
    };
  };
  const due = (hash: string) =>
    db.query('UPDATE staff_sso_refresh SET access_expires_at=$2 WHERE token_hash=$1', [
      hash,
      new Date(Date.now() - 1000),
    ]);
  return {
    app,
    db,
    config,
    anotherApp,
    login,
    due,
    revoked,
    access,
    refresh,
    rotations: () => rotations,
    change: (
      v: Partial<{
        sub: string;
        aud: string;
        roles: string[];
        active: boolean;
        refreshSeconds: number;
        failedRevoke: boolean;
        hold: () => Promise<void>;
        introspectionHold: (token: string) => Promise<void>;
        tokenFailure: typeof tokenFailure;
      }>,
    ) => {
      sub = v.sub ?? sub;
      aud = v.aud ?? aud;
      roles = v.roles ?? roles;
      active = v.active ?? active;
      refreshSeconds = v.refreshSeconds ?? refreshSeconds;
      failedRevoke = v.failedRevoke ?? failedRevoke;
      hold = v.hold ?? hold;
      introspectionHold = v.introspectionHold ?? introspectionHold;
      tokenFailure = v.tokenFailure;
    },
    close: async () => {
      await Promise.all(apps.map((a) => a.close()));
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('SSO opts into refresh, encrypts both tokens and caps the local session at eight absolute hours', async () => {
  const f = await fixture();
  try {
    const login = await f.login();
    assert.ok(login.session.maxAge! <= 28800 && login.session.maxAge! > 28790);
    assert.ok(login.session.secure && login.session.httpOnly);
    const [original] = await f.db.query(
      'SELECT expires_at FROM auth_sessions WHERE token_hash=$1',
      [login.hash],
    );
    const [stored] = await f.db.query('SELECT * FROM staff_sso_refresh WHERE token_hash=$1', [
      login.hash,
    ]);
    assert.notEqual(stored.encrypted_refresh_token, f.refresh());
    assert.equal(decrypt(stored.encrypted_refresh_token, f.config.encryptionKey), f.refresh());
    assert.ok(!login.response.body.includes(f.refresh()));
    await f.due(login.hash);
    f.change({ refreshSeconds: 80000 });
    const response = await f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes(f.access()) && !response.body.includes(f.refresh()));
    assert.equal(f.rotations(), 1);
    const [current] = await f.db.query('SELECT expires_at FROM auth_sessions WHERE token_hash=$1', [
      login.hash,
    ]);
    assert.equal(new Date(current.expires_at).getTime(), new Date(original.expires_at).getTime());
    const [rotated] = await f.db.query('SELECT * FROM staff_sso_refresh WHERE token_hash=$1', [
      login.hash,
    ]);
    assert.equal(decrypt(rotated.encrypted_refresh_token, f.config.encryptionKey), f.refresh());
    assert.equal(rotated.rotation_id, null);
    // Absolute expiry wins even if the provider would still accept refresh.
    await f.db.query('UPDATE auth_sessions SET expires_at=$2 WHERE token_hash=$1', [
      login.hash,
      new Date(Date.now() - 1),
    ]);
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } })).statusCode,
      401,
    );
    assert.equal(f.rotations(), 1);
  } finally {
    await f.close();
  }
});

test('refresh expiry from CUSA can shorten the session, never extend it', async () => {
  const f = await fixture();
  try {
    f.change({ refreshSeconds: 3600 });
    const login = await f.login();
    assert.ok(login.session.maxAge! <= 3600 && login.session.maxAge! > 3590);
    await f.due(login.hash);
    f.change({ refreshSeconds: 90 });
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } })).statusCode,
      200,
    );
    const [row] = await f.db.query('SELECT expires_at FROM auth_sessions WHERE token_hash=$1', [
      login.hash,
    ]);
    assert.ok(new Date(row.expires_at).getTime() <= Date.now() + 90000);
  } finally {
    await f.close();
  }
});

test('concurrent requests across app instances rotate exactly once and all use the new token', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const other = await f.anotherApp(),
      login = await f.login();
    await f.due(login.hash);
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.change({
      hold: async () => {
        entered();
        await gate;
      },
    });
    const first = f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } });
    await started;
    const [marker] = await f.db.query(
      'SELECT rotation_id FROM staff_sso_refresh WHERE token_hash=$1',
      [login.hash],
    );
    assert.ok(marker.rotation_id, 'claim must be durable before contacting CUSA');
    const rest = Array.from({ length: 5 }, () =>
      other.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } }),
    );
    release();
    const replies = await Promise.all([first, ...rest]);
    for (const r of replies) assert.equal(r.statusCode, 200, r.body);
    assert.equal(f.rotations(), 1);
  } finally {
    release?.();
    await f.close();
  }
});

test('timeout, errors, incomplete rotations, reused tokens and increased scopes never retry the credential', async () => {
  const f = await fixture();
  try {
    for (const failure of [
      'network',
      '500',
      '429',
      'invalid',
      'malformed',
      'reuse',
      'scope',
    ] as const) {
      f.change({ tokenFailure: failure });
      const login = await f.login();
      await f.due(login.hash);
      const before = f.rotations();
      const response = await f.app.inject({
        url: '/api/settings',
        headers: { cookie: login.cookie },
      });
      assert.equal(response.statusCode, 401, failure + response.body);
      assert.ok(!response.body.includes('provider error'));
      assert.equal(
        (await f.db.query('SELECT * FROM auth_sessions WHERE token_hash=$1', [login.hash])).length,
        0,
      );
      assert.equal(
        (await f.app.inject({ url: '/api/settings', headers: { cookie: login.cookie } }))
          .statusCode,
        401,
      );
      assert.equal(f.rotations(), before + 1, failure);
    }
  } finally {
    await f.close();
  }
});

test('a persisted interrupted rotation and a changed API key require new login without refresh reuse', async () => {
  const f = await fixture();
  try {
    const login = await f.login();
    await f.due(login.hash);
    await f.db.query(
      'UPDATE staff_sso_refresh SET rotation_id=$2,rotation_started_at=$3 WHERE token_hash=$1',
      [login.hash, randomUUID(), new Date(Date.now() - 60000)],
    );
    const restarted = await f.anotherApp();
    assert.equal(
      (await restarted.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } }))
        .statusCode,
      401,
    );
    assert.equal(f.rotations(), 0);
    const next = await f.login();
    f.config.ssoApiKey = 'different-key';
    assert.equal(
      (await restarted.inject({ url: '/api/auth/me', headers: { cookie: next.cookie } }))
        .statusCode,
      401,
    );
    assert.equal(f.rotations(), 0);
  } finally {
    await f.close();
  }
});

test('failed atomic persistence after provider rotation ends the local session without retry', async () => {
  const f = await fixture();
  try {
    const login = await f.login();
    await f.due(login.hash);
    const broken: Database = {
      ...f.db,
      transaction: (fn) =>
        f.db.transaction((tx) =>
          fn({
            ...tx,
            query: async (sql, params) => {
              if (sql.startsWith('UPDATE staff_sso_sessions'))
                throw new Error('synthetic database outage');
              return tx.query(sql, params);
            },
          }),
        ),
    };
    const other = await f.anotherApp(broken);
    assert.equal(
      (await other.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } })).statusCode,
      401,
    );
    assert.equal(
      (await f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } })).statusCode,
      401,
    );
    assert.equal(f.rotations(), 1);
  } finally {
    await f.close();
  }
});

test('permissions are checked after refresh; revoked, foreign and changed identities cannot authorize', async () => {
  const f = await fixture();
  try {
    const login = await f.login();
    await f.due(login.hash);
    f.change({ roles: ['agent'] });
    assert.equal(
      (await f.app.inject({ url: '/api/settings', headers: { cookie: login.cookie } })).statusCode,
      403,
    );
    assert.equal(f.rotations(), 1);
    f.change({ active: false });
    assert.equal(
      (await f.app.inject({ url: '/api/conversations', headers: { cookie: login.cookie } }))
        .statusCode,
      401,
    );
    assert.equal(f.rotations(), 1, 'do not refresh merely because introspection says inactive');
    for (const change of [{ sub: randomUUID() }, { aud: randomUUID() }, { roles: ['member'] }]) {
      f.change({ active: true, roles: ['admin'], aud: f.config.ssoClientId });
      const next = await f.login();
      await f.due(next.hash);
      f.change(change);
      assert.equal(
        (await f.app.inject({ url: '/api/settings', headers: { cookie: next.cookie } })).statusCode,
        401,
      );
    }
  } finally {
    await f.close();
  }
});

test('logout revokes at CUSA, always removes local credentials and cannot be undone by an in-flight refresh', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const login = await f.login();
    await f.due(login.hash);
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.change({
      hold: async () => {
        entered();
        await gate;
      },
    });
    const pending = f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } });
    await started;
    const logout = await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: login.cookie, origin: f.config.origin },
      payload: {},
    });
    assert.equal(logout.json().ssoRevoked, true);
    assert.equal(f.revoked[0], 'a'.repeat(43));
    assert.equal(logout.cookies.find((c) => c.name === 'cusa_session')?.value, '');
    release();
    assert.equal((await pending).statusCode, 401);
    assert.equal((await f.db.query('SELECT * FROM staff_sso_refresh')).length, 0);
    f.change({ failedRevoke: true });
    const next = await f.login();
    const fail = await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: next.cookie, origin: f.config.origin },
      payload: {},
    });
    assert.equal(fail.statusCode, 200);
    assert.equal(fail.json().ssoRevoked, false);
    assert.equal((await f.db.query('SELECT * FROM auth_sessions')).length, 0);
  } finally {
    release?.();
    await f.close();
  }
});

test('a late inactive introspection response for a rotated token does not log out a valid session', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const login = await f.login(),
      other = await f.anotherApp();
    const original = f.access();
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.change({
      introspectionHold: async (token) => {
        if (token === original) {
          entered();
          await gate;
        }
      },
    });
    const pending = f.app.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } });
    await started;
    await f.due(login.hash);
    assert.equal(
      (await other.inject({ url: '/api/auth/me', headers: { cookie: login.cookie } })).statusCode,
      200,
    );
    release();
    const response = await pending;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.rotations(), 1);
    assert.equal(
      (await f.db.query('SELECT * FROM auth_sessions WHERE token_hash=$1', [login.hash])).length,
      1,
    );
  } finally {
    release?.();
    await f.close();
  }
});
