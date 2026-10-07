import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../server/config.js';
import { buildApp } from '../server/app.js';
import { seed } from '../server/seed.js';
import { tokenHash } from '../server/security.js';
import { openDatabase } from './database.js';

const callbackPath = '/api/auth/callback';
const flowConfig = {
  staff: {
    table: 'staff_sso_transactions',
    cookie: 'cusa_staff_login',
    invalid: '/admin?auth=invalid',
  },
  member: { table: 'sso_transactions', cookie: 'cusa_link', invalid: '/connect?result=invalid' },
} as const;
type Flow = keyof typeof flowConfig;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cusa-callback-'));
  const config = {
    ...getConfig({ APP_MODE: 'demo', DATA_DIR: root }),
    demo: false,
    origin: 'https://desk.example.org',
    ssoOrigin: 'https://sso.example.org',
    ssoClientId: randomUUID(),
    ssoApiKey: 'test-backend-key',
    lineLoginChannelId: '123456',
  };
  const db = await openDatabase({ memory: true });
  await seed(db, config);
  const lineUserId = 'U' + randomBytes(16).toString('hex');
  // The same CUSA account can both link LINE and sign in as staff. Roles cannot select the flow.
  const profile = {
    sub: randomUUID(),
    aud: config.ssoClientId,
    roles: ['admin'],
    scope: 'identity:read',
  };
  const codes = new Map<string, { challenge: string; flow: Flow }>();
  const grants: Record<string, unknown>[] = [];
  let introspections = 0;
  const fetcher = (async (url: unknown, init: any) => {
    const path = new URL(String(url)).pathname;
    if (path === '/oauth2/v2.1/verify') {
      return Response.json({
        sub: lineUserId,
        aud: config.lineLoginChannelId,
        iss: 'https://access.line.me',
        exp: Math.floor(Date.now() / 1000) + 300,
      });
    }
    if (path === '/api/sso/token') {
      const body = JSON.parse(init.body);
      grants.push(body);
      const issued = codes.get(body.code);
      assert.equal(body.redirect_uri, config.origin + callbackPath);
      if (
        !issued ||
        createHash('sha256').update(body.code_verifier).digest('base64url') !== issued.challenge
      )
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      codes.delete(body.code);
      assert.equal(body.request_refresh_token, issued.flow === 'staff' ? true : undefined);
      return Response.json({
        access_token: 'A'.repeat(43),
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'identity:read',
        ...(issued.flow === 'staff'
          ? { refresh_token: 'R'.repeat(43), refresh_expires_in: 28800 }
          : {}),
      });
    }
    if (path === '/api/sso/userinfo') return Response.json(profile);
    if (path === '/api/sso/introspect') {
      introspections++;
      return Response.json({ ...profile, active: true, exp: Math.floor(Date.now() / 1000) + 300 });
    }
    throw new Error('Unexpected provider request');
  }) as typeof fetch;
  const app = await buildApp(db, config, { fetcher });
  const start = async (flow: Flow) => {
    const response = await app.inject({
      method: 'POST',
      url: flow === 'staff' ? '/api/auth/sso/start' : '/api/connect/start',
      headers: { origin: config.origin },
      payload: flow === 'staff' ? {} : { idToken: 'test-signed-line-id-token' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const authorize = new URL(response.json().url);
    assert.equal(authorize.searchParams.get('redirect_uri'), config.origin + callbackPath);
    const browser = response.cookies.find((c) => c.name === flowConfig[flow].cookie)!;
    assert.equal(browser.path, callbackPath);
    assert.ok(browser.httpOnly && browser.secure);
    assert.equal(browser.sameSite, 'Lax');
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { challenge: authorize.searchParams.get('code_challenge')!, flow });
    const state = authorize.searchParams.get('state')!;
    return {
      flow,
      state,
      code,
      cookie: `${browser.name}=${browser.value}`,
      url: `${callbackPath}?state=${state}&code=${code}`,
    };
  };
  return {
    app,
    db,
    config,
    fetcher,
    start,
    lineUserId,
    profile,
    grants,
    introspections: () => introspections,
    close: async () => {
      await app.close();
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const first of ['member', 'staff'] as const) {
  test(`one callback separates simultaneous flows when ${first} completes first`, async () => {
    const f = await fixture();
    try {
      const staff = await f.start('staff'),
        member = await f.start('member');
      let cookie = `${staff.cookie}; ${member.cookie}`;
      const order = first === 'member' ? [member, staff] : [staff, member];
      for (const [index, flow] of order.entries()) {
        const other = flow.flow === 'member' ? staff : member;
        const response = await f.app.inject({
          url:
            flow.url +
            `&flow=${other.flow}&lineUserId=attacker&returnTo=https://foreign.example.org`,
          headers: { cookie },
        });
        assert.equal(
          response.headers.location,
          flow.flow === 'staff' ? '/admin/overview' : '/connect?result=success',
        );
        assert.ok(
          response.cookies.some(
            (c) =>
              c.name === flowConfig[flow.flow].cookie && c.maxAge === 0 && c.path === callbackPath,
          ),
        );
        assert.ok(!response.cookies.some((c) => c.name === flowConfig[other.flow].cookie));
        if (flow.flow === 'member') {
          assert.ok(!response.cookies.some((c) => c.name === 'cusa_session'));
          const [linked] = await f.db.query('SELECT * FROM users WHERE cusa_sub=$1', [
            f.profile.sub,
          ]);
          assert.equal(linked.line_user_id, f.lineUserId);
        } else {
          const session = response.cookies.find((c) => c.name === 'cusa_session')!;
          assert.ok(session.value && session.maxAge! > 300);
          cookie += `; cusa_session=${session.value}`;
        }
        if (index === 0) {
          assert.equal(
            (await f.db.query(`SELECT * FROM ${flowConfig[other.flow].table}`)).length,
            1,
          );
          assert.equal(
            (await f.db.query('SELECT * FROM auth_sessions')).length,
            first === 'staff' ? 1 : 0,
          );
          assert.equal(
            (await f.db.query('SELECT * FROM users WHERE cusa_sub=$1', [f.profile.sub])).length,
            first === 'member' ? 1 : 0,
          );
        }
      }
      assert.equal((await f.db.query('SELECT * FROM auth_sessions')).length, 1);
      assert.equal((await f.db.query('SELECT * FROM staff_sso_refresh')).length, 1);
      assert.equal(f.grants.length, 2);
      assert.equal(f.introspections(), 1, 'LINE linking does not authenticate staff');
    } finally {
      await f.close();
    }
  });
}

test('the shared callback rejects missing, wrong or swapped browser cookies without consuming either flow', async () => {
  const f = await fixture();
  try {
    const staff = await f.start('staff'),
      member = await f.start('member');
    for (const flow of [staff, member]) {
      const other = flow.flow === 'staff' ? member : staff;
      for (const cookie of [
        '',
        other.cookie,
        `${flowConfig[flow.flow].cookie}=wrong; ${other.cookie}`,
      ]) {
        const response = await f.app.inject({ url: flow.url, headers: { cookie } });
        assert.equal(response.headers.location, flowConfig[flow.flow].invalid);
        assert.equal(response.cookies.length, 0);
      }
    }
    assert.equal(f.grants.length, 0);
    for (const flow of [staff, member]) {
      assert.equal((await f.db.query(`SELECT * FROM ${flowConfig[flow.flow].table}`)).length, 1);
      const result = await f.app.inject({
        url: flow.url,
        headers: { cookie: `${member.cookie}; ${staff.cookie}` },
      });
      assert.equal(
        result.headers.location,
        flow.flow === 'staff' ? '/admin/overview' : '/connect?result=success',
      );
    }
  } finally {
    await f.close();
  }
});

test('errors, expired or ambiguous state and malformed input never exchange a code', async () => {
  const f = await fixture();
  try {
    for (const kind of ['staff', 'member'] as const) {
      for (const query of ['error=access_denied', 'error=&code=' + 'B'.repeat(43), '']) {
        const flow = await f.start(kind);
        const response = await f.app.inject({
          url: `${callbackPath}?state=${flow.state}&${query}`,
          headers: { cookie: flow.cookie },
        });
        assert.equal(response.headers.location, flowConfig[kind].invalid);
        assert.equal(
          (
            await f.db.query(`SELECT * FROM ${flowConfig[kind].table} WHERE state_hash=$1`, [
              tokenHash(flow.state),
            ])
          ).length,
          0,
        );
      }
      const expired = await f.start(kind);
      await f.db.query(`UPDATE ${flowConfig[kind].table} SET expires_at=$1 WHERE state_hash=$2`, [
        new Date(Date.now() - 1000),
        tokenHash(expired.state),
      ]);
      assert.equal(
        (await f.app.inject({ url: expired.url, headers: { cookie: expired.cookie } })).headers
          .location,
        flowConfig[kind].invalid,
      );
    }
    const staff = await f.start('staff'),
      member = await f.start('member');
    const cookie = `${staff.cookie}; ${member.cookie}`;
    for (const url of [
      callbackPath,
      `${callbackPath}?state=bad&code=${staff.code}`,
      `${callbackPath}?state=${staff.state}&code=invalid`,
      `${callbackPath}?state=${staff.state}&state=${member.state}&code=${staff.code}`,
      `${callbackPath}?state=${'Z'.repeat(43)}&code=${staff.code}`,
    ]) {
      const response = await f.app.inject({ url, headers: { cookie } });
      assert.equal(response.statusCode, 302);
      assert.equal(response.cookies.length, 0);
    }
    await f.db.query('UPDATE sso_transactions SET state_hash=$1 WHERE state_hash=$2', [
      tokenHash(staff.state),
      tokenHash(member.state),
    ]);
    const ambiguous = await f.app.inject({ url: staff.url, headers: { cookie } });
    assert.equal(ambiguous.headers.location, '/connect?result=invalid');
    assert.equal(ambiguous.cookies.length, 0);
    assert.equal(f.grants.length, 0);
    assert.equal((await f.db.query('SELECT * FROM auth_sessions')).length, 0);
  } finally {
    await f.close();
  }
});

test('PKCE prevents codes from crossing flows even when both browser cookies are present', async () => {
  const f = await fixture();
  try {
    const staff = await f.start('staff'),
      member = await f.start('member');
    const cookie = `${staff.cookie}; ${member.cookie}`;
    const response = await f.app.inject({
      url: `${callbackPath}?state=${staff.state}&code=${member.code}`,
      headers: { cookie },
    });
    assert.equal(response.headers.location, '/admin?auth=denied');
    assert.equal((await f.db.query('SELECT * FROM auth_sessions')).length, 0);
    const linked = await f.app.inject({ url: member.url, headers: { cookie } });
    assert.equal(linked.headers.location, '/connect?result=success');
    assert.equal((await f.db.query('SELECT * FROM auth_sessions')).length, 0);
  } finally {
    await f.close();
  }
});

test('simultaneous callbacks across app instances consume each state only once', async () => {
  const f = await fixture();
  const otherApp = await buildApp(f.db, f.config, { fetcher: f.fetcher });
  try {
    for (const kind of ['staff', 'member'] as const) {
      const flow = await f.start(kind);
      const responses = await Promise.all(
        [f.app, otherApp].map((app) =>
          app.inject({ url: flow.url, headers: { cookie: flow.cookie } }),
        ),
      );
      assert.deepEqual(
        responses.map((r) => r.headers.location).sort(),
        [
          flowConfig[kind].invalid,
          kind === 'staff' ? '/admin/overview' : '/connect?result=success',
        ].sort(),
      );
      assert.equal(
        (await f.app.inject({ url: flow.url, headers: { cookie: flow.cookie } })).headers.location,
        flowConfig[kind].invalid,
      );
    }
    assert.equal(f.grants.length, 2);
  } finally {
    await otherApp.close();
    await f.close();
  }
});
