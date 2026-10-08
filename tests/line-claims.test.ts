import type { Agent } from '../shared/types.js';
import type { Row } from '../server/db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../server/config.js';
import { openDatabase } from './database.js';
import { buildApp } from '../server/app.js';
import { Worker } from '../server/worker.js';
import { claimCase } from '../server/conversations.js';
import { claimActionData, caseFlex, readClaimAction } from '../server/line-flex.js';
import { processLineClaim, replyLineClaim } from '../server/line-claims.js';
import { queueLineProfile, updateLineProfile } from '../server/line-profiles.js';
import { bindStaffLine, ssoLineIdentity } from '../server/staff-line.js';
import { cusaClaimScopes } from '../shared/sso.js';
import { decrypt } from '../server/security.js';

const ssoLine = 'U' + 'a'.repeat(32),
  localLine = 'U' + 'b'.repeat(32),
  group = 'C' + 'c'.repeat(32);
async function fixture(sameProvider = true) {
  const root = await mkdtemp(join(tmpdir(), 'cusa-line-claims-'));
  const config = {
    ...getConfig({
      APP_MODE: 'demo',
      DATA_DIR: root,
      CUSA_LINE_SAME_PROVIDER: String(sameProvider),
      CUSA_CLAIM_SCOPES: 'identity:read profile email line',
    }),
    demo: false,
    origin: 'https://desk.example.org',
    ssoOrigin: 'https://sso.example.org',
    ssoClientId: randomUUID(),
    ssoApiKey: 'synthetic-key',
    lineToken: 'synthetic-token',
    lineSecret: 'synthetic-secret',
    lineLoginChannelId: '123456789',
    liffId: '123456789-test',
  };
  const db = await openDatabase({ memory: true });
  const sub = randomUUID();
  let roles = ['agent'],
    active = true,
    lineId = ssoLine,
    localProofId = localLine,
    profileName = 'ชื่อไลน์จริง',
    rejectPush = false;
  const calls: { path: string; body: any; retry?: string }[] = [];
  const fetcher = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/oauth2/v2.1/verify') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'), config.lineLoginChannelId);
      if (body.get('id_token') === 'invalid-line-token'.repeat(3))
        return Response.json({ error: 'invalid token' }, { status: 400 });
      return Response.json({
        sub: localProofId,
        aud: config.lineLoginChannelId,
        iss: 'https://access.line.me',
        exp: Math.floor(Date.now() / 1000) + 300,
      });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      body,
      retry: (init?.headers as Record<string, string>)?.['X-Line-Retry-Key'],
    });
    if (path === '/api/sso/token')
      return Response.json({
        access_token: 'A'.repeat(43),
        token_type: 'Bearer',
        expires_in: 300,
        scope: config.ssoClaimScopes,
      });
    const identity = {
      sub,
      aud: config.ssoClientId,
      roles,
      scope: config.ssoClaimScopes,
      name: 'เจ้าหน้าที่ทดสอบ',
      line: { linked: true, user_id: lineId, login_channel_id: '987654321' },
    };
    if (path === '/api/sso/userinfo') return Response.json(identity);
    if (path === '/api/sso/introspect')
      return Response.json({ ...identity, active, exp: Math.floor(Date.now() / 1000) + 300 });
    if (path.startsWith('/v2/bot/profile/'))
      return Response.json({ userId: path.split('/').pop(), displayName: profileName });
    if (path === '/v2/bot/message/push' || path === '/v2/bot/message/reply')
      return Response.json({}, { status: rejectPush && path.endsWith('/push') ? 500 : 200 });
    throw new Error('Unexpected synthetic provider call: ' + path);
  }) as typeof fetch;
  const app = await buildApp(db, config, { fetcher });
  const worker = new Worker(db, config, fetcher);
  const login = async (input: object = {}) => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/sso/start',
      headers: { origin: config.origin },
      payload: input,
    });
    assert.equal(start.statusCode, 200, start.body);
    const url = new URL(start.json().url);
    const response = await app.inject({
      url: '/api/auth/callback?state=' + url.searchParams.get('state') + '&code=' + 'B'.repeat(43),
      headers: { cookie: start.cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    return {
      url,
      response,
      agent: (
        await db.query<Agent & Row>(
          'SELECT a.* FROM agents a JOIN staff_identities i ON i.agent_id=a.id WHERE i.cusa_sub=$1',
          [sub],
        )
      )[0],
    };
  };
  const waiting = async () => {
    const [user] = await db.query(
      "INSERT INTO users(line_user_id,name) VALUES($1,'สมาชิก LINE') RETURNING *",
      ['U' + randomUUID().replaceAll('-', '')],
    );
    const [c] = await db.query(
      "INSERT INTO conversations(user_id,status,handover_at) VALUES($1,'WAITING_FOR_AGENT',now()) RETURNING *",
      [user.id],
    );
    return { user, c };
  };
  const event = (c: any, uid = ssoLine) => ({
    webhookEventId: randomUUID(),
    type: 'postback',
    timestamp: Date.now(),
    source: { type: 'group', groupId: group, userId: uid },
    replyToken: 'synthetic-reply',
    postback: { data: claimActionData(config, c.id, c.routing_version, group) },
  });
  return {
    config,
    db,
    app,
    worker,
    fetcher,
    calls,
    login,
    waiting,
    event,
    change: (v: {
      roles?: string[];
      active?: boolean;
      lineId?: string;
      localProofId?: string;
      rejectPush?: boolean;
      profileName?: string;
    }) => {
      roles = v.roles ?? roles;
      active = v.active ?? active;
      lineId = v.lineId ?? lineId;
      localProofId = v.localProofId ?? localProofId;
      rejectPush = v.rejectPush ?? rejectPush;
      profileName = v.profileName ?? profileName;
    },
    close: async () => {
      await worker.stop();
      await app.close();
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('claim scopes are explicit and independent of Provider matching', () => {
  assert.equal(cusaClaimScopes(undefined, false), 'identity:read profile email');
  assert.equal(cusaClaimScopes('identity:read', false), 'identity:read');
  assert.equal(
    cusaClaimScopes('identity:read profile email line', false),
    'identity:read profile email line',
  );
  assert.equal(cusaClaimScopes('identity:read line line', true), 'identity:read line');
  assert.equal(cusaClaimScopes(undefined, true), 'identity:read profile email line');
  assert.throws(() => cusaClaimScopes('profile line', false));
  assert.throws(() => cusaClaimScopes('identity:read unknown', false));
});

test('SSO links verified LINE only on the same Provider, preserves opt-out, and returns to the original case', async () => {
  const f = await fixture();
  try {
    const target = '/admin/inbox?case=' + randomUUID();
    const flow = await f.login({ returnTo: target });
    assert.equal(flow.url.searchParams.get('scope'), 'identity:read profile email line');
    assert.equal(flow.response.headers.location, target);
    assert.equal(flow.agent.line_user_id, ssoLine);
    assert.equal(flow.agent.line_identity_source, 'SSO');
    assert.equal(flow.agent.line_alerts_enabled, true);
    assert.equal(
      ssoLineIdentity(f.config, {
        scope: 'identity:read',
        line: { linked: true, user_id: ssoLine },
      }),
      null,
    );
    await f.db.query('UPDATE agents SET line_alerts_enabled=false WHERE id=$1', [flow.agent.id]);
    const again = await f.login({ returnTo: 'https://foreign.example.org/' });
    assert.equal(again.response.headers.location, '/admin/overview');
    assert.equal(again.agent.line_alerts_enabled, false);
    const otherId = randomUUID();
    await f.db.query(
      "INSERT INTO agents(id,name,email,password_hash,role) VALUES($1,'Other','other@example.org','unused','AGENT')",
      [otherId],
    );
    await assert.rejects(
      f.db.transaction((tx) =>
        bindStaffLine(tx, otherId, { userId: ssoLine, channelId: '987654321' }, 'SSO'),
      ),
      /อีกบัญชี/,
    );
  } finally {
    await f.close();
  }
});

test('different Provider ignores the SSO UID; local LIFF proof plus SSO staff identity enables claims', async () => {
  const f = await fixture(false);
  try {
    const initial = await f.login();
    assert.equal(initial.agent.line_user_id, null);
    const linked = await f.login({
      lineIdToken: 'synthetic-id-token'.repeat(3),
      lineUserId: ssoLine,
    });
    assert.equal(linked.agent.line_user_id, localLine);
    assert.equal(linked.agent.line_identity_source, 'OA_LINK');
    assert.equal(linked.response.headers.location, '/connect/staff?result=success');
    const { c } = await f.waiting();
    const ev = f.event(c, localLine);
    await processLineClaim(f.db, f.config, ev.webhookEventId, ev, f.fetcher);
    assert.equal(
      (await f.db.query('SELECT assigned_agent_id FROM conversations WHERE id=$1', [c.id]))[0]
        .assigned_agent_id,
      linked.agent.id,
    );
  } finally {
    await f.close();
  }
});

test('signed Flex postback claims once, notifies customer and staff, and rejects forwarded or stale actions', async () => {
  const f = await fixture();
  try {
    const { agent } = await f.login();
    const { c, user } = await f.waiting();
    const flex = caseFlex(f.config, {
      id: c.id,
      number: c.number,
      version: c.routing_version,
      recipient: group,
    });
    assert.equal(flex.type, 'flex');
    const data = claimActionData(f.config, c.id, c.routing_version, group);
    assert.ok(data.length <= 300);
    assert.equal(readClaimAction(f.config, data, localLine), null);
    assert.equal(readClaimAction(f.config, data.replace('|0|', '|1|'), group), null);
    const ev = f.event(c);
    const payload = JSON.stringify({ events: [ev] });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/webhook',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': createHmac('sha256', f.config.lineSecret)
          .update(payload)
          .digest('base64'),
      },
      payload,
    });
    assert.equal(response.statusCode, 200);
    await f.worker.tick();
    const [claimed] = await f.db.query('SELECT * FROM conversations WHERE id=$1', [c.id]);
    assert.equal(claimed.assigned_agent_id, agent.id);
    assert.equal(claimed.status, 'AGENT_IN_CHARGE');
    assert.equal(
      (await f.db.query('SELECT id FROM users')).length,
      1,
      'group action must not create group conversations',
    );
    const [ack] = await f.db.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND NOT internal AND sender_type='SYSTEM'",
      [c.id],
    );
    assert.equal(ack.delivery_status, 'ACCEPTED');
    assert.match(decrypt(ack.encrypted_text, f.config.encryptionKey), /เจ้าหน้าที่รับเรื่องแล้ว/);
    const pushes = f.calls.filter((c) => c.path.endsWith('/push'));
    assert.equal(pushes.length, 2);
    assert.ok(
      pushes.some((p) => p.body.to === user.line_user_id && p.body.messages[0].type === 'text'),
    );
    assert.ok(pushes.some((p) => p.body.to === ssoLine && p.body.messages[0].type === 'flex'));
    await processLineClaim(f.db, f.config, ev.webhookEventId, ev, f.fetcher);
    await replyLineClaim(f.db, f.config, ev.webhookEventId, f.fetcher);
    assert.equal(f.calls.filter((c) => c.path.endsWith('/reply')).length, 1);
    assert.equal(
      (
        await f.db.query('SELECT id FROM messages WHERE conversation_id=$1 AND NOT internal', [
          c.id,
        ])
      ).length,
      1,
    );
    const fresh = await f.waiting();
    const stale = f.event(fresh.c);
    await f.db.query('UPDATE conversations SET routing_version=1 WHERE id=$1', [fresh.c.id]);
    await processLineClaim(f.db, f.config, stale.webhookEventId, stale, f.fetcher);
    assert.equal(
      (await f.db.query('SELECT status FROM conversations WHERE id=$1', [fresh.c.id]))[0].status,
      'WAITING_FOR_AGENT',
    );
  } finally {
    await f.close();
  }
});

test('claims fail closed for unknown, manual-only, changed, expired, or revoked staff identities', async () => {
  const f = await fixture();
  try {
    const { agent } = await f.login();
    for (const reason of ['unknown', 'manual', 'changed', 'reviewer', 'revoked', 'expired']) {
      await f.db.query("UPDATE agents SET line_identity_source='SSO',role='AGENT' WHERE id=$1", [
        agent.id,
      ]);
      f.change({ roles: ['agent'], active: true, lineId: ssoLine });
      if (reason === 'manual')
        await f.db.query('UPDATE agents SET line_identity_source=NULL WHERE id=$1', [agent.id]);
      if (reason === 'changed') f.change({ lineId: localLine });
      if (reason === 'reviewer') f.change({ roles: ['reviewer'] });
      if (reason === 'revoked') f.change({ active: false });
      if (reason === 'expired')
        await f.db.query("UPDATE auth_sessions SET expires_at=now()-interval '1 minute'");
      const { c } = await f.waiting(),
        ev = f.event(c, reason === 'unknown' ? localLine : ssoLine);
      await processLineClaim(f.db, f.config, ev.webhookEventId, ev, f.fetcher);
      assert.equal(
        (await f.db.query('SELECT status FROM conversations WHERE id=$1', [c.id]))[0].status,
        'WAITING_FOR_AGENT',
        reason,
      );
      assert.equal(
        (await f.db.query('SELECT id FROM messages WHERE conversation_id=$1', [c.id])).length,
        0,
      );
    }
  } finally {
    await f.close();
  }
});

test('simultaneous claims produce one customer acknowledgement; failed Push retries keep one key and stale acknowledgement cancels', async () => {
  const f = await fixture();
  try {
    const { agent } = await f.login();
    const { c, user } = await f.waiting();
    const results = await Promise.allSettled([
      claimCase(f.db, f.config, agent, c.id),
      claimCase(f.db, f.config, agent, c.id),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const [ack] = await f.db.query(
      'SELECT * FROM messages WHERE conversation_id=$1 AND NOT internal',
      [c.id],
    );
    f.change({ rejectPush: true });
    await assert.rejects(f.worker.deliver(ack.id));
    f.change({ rejectPush: false });
    await f.worker.deliver(ack.id);
    const attempts = f.calls.filter(
      (c) => c.path.endsWith('/push') && c.body.to === user.line_user_id,
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].retry, attempts[1].retry);
    assert.deepEqual(attempts[0].body, attempts[1].body);
    const another = await f.waiting();
    await claimCase(f.db, f.config, agent, another.c.id);
    const [outdated] = await f.db.query(
      'SELECT * FROM messages WHERE conversation_id=$1 AND NOT internal',
      [another.c.id],
    );
    await f.db.query(
      "UPDATE conversations SET status='WAITING_FOR_AGENT',routing_version=1 WHERE id=$1",
      [another.c.id],
    );
    await f.worker.deliver(outdated.id);
    assert.equal(
      (await f.db.query('SELECT delivery_status FROM messages WHERE id=$1', [outdated.id]))[0]
        .delivery_status,
      'CANCELLED',
    );
  } finally {
    await f.close();
  }
});

test('LINE profile updates guest name, preserves CUSA name, and queues a deduplicated refresh', async () => {
  const f = await fixture();
  try {
    const { user } = await f.waiting();
    await queueLineProfile(f.db, f.config, user.id);
    await queueLineProfile(f.db, f.config, user.id);
    assert.equal((await f.db.query("SELECT id FROM jobs WHERE kind='LINE_PROFILE'")).length, 1);
    await updateLineProfile(f.db, f.config, user.id, f.fetcher);
    let [saved] = await f.db.query('SELECT * FROM users WHERE id=$1', [user.id]);
    assert.equal(saved.name, 'ชื่อไลน์จริง');
    assert.equal(saved.line_display_name, 'ชื่อไลน์จริง');
    await f.db.query("UPDATE users SET cusa_sub=$2,name='ชื่อจาก CUSA' WHERE id=$1", [
      user.id,
      randomUUID(),
    ]);
    f.change({ profileName: 'LINE เปลี่ยนชื่อ' });
    await updateLineProfile(f.db, f.config, user.id, f.fetcher);
    [saved] = await f.db.query('SELECT * FROM users WHERE id=$1', [user.id]);
    assert.equal(saved.name, 'ชื่อจาก CUSA');
    assert.equal(saved.line_display_name, 'LINE เปลี่ยนชื่อ');
    await assert.rejects(
      updateLineProfile(f.db, f.config, user.id, (async () =>
        Response.json({}, { status: 503 })) as typeof fetch),
    );
    assert.equal(
      (await f.db.query('SELECT name FROM users WHERE id=$1', [user.id]))[0].name,
      'ชื่อจาก CUSA',
    );
  } finally {
    await f.close();
  }
});

const sessionCookie = (response: { cookies: { name: string; value: string }[] }) =>
  response.cookies
    .filter((c) => c.name === 'cusa_session')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

test('same Provider account shows SSO binding and forbids self unlink/rebind including the legacy linking entry', async () => {
  const f = await fixture();
  try {
    f.change({ roles: ['admin'] });
    const flow = await f.login({ returnTo: '/admin/account' });
    assert.equal(flow.response.headers.location, '/admin/account');
    const headers = { cookie: sessionCookie(flow.response), origin: f.config.origin };
    const account = await f.app.inject({ url: '/api/account', headers });
    assert.equal(account.statusCode, 200, account.body);
    assert.deepEqual(account.json().line, {
      userId: ssoLine,
      source: 'SSO',
      verified: true,
      enabled: true,
    });
    assert.equal(account.json().lineManagedBySso, true);
    assert.equal(account.json().canLinkLine, false);
    const proof = { accountId: flow.agent.id, expectedCurrentUserId: ssoLine };
    assert.equal(
      (await f.app.inject({ method: 'DELETE', url: '/api/account/line', headers, payload: proof }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/account/line',
          headers,
          payload: { ...proof, source: 'OA_LINK', lineIdToken: 'synthetic-id-token'.repeat(3) },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/sso/start',
          headers,
          payload: { lineIdToken: 'synthetic-id-token'.repeat(3) },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PATCH',
          url: `/api/agents/${flow.agent.id}/line-notifications`,
          headers,
          payload: { userId: null, enabled: false },
        })
      ).statusCode,
      400,
    );
    const muted = await f.app.inject({
      method: 'PATCH',
      url: '/api/account/line',
      headers,
      payload: { ...proof, enabled: false },
    });
    assert.equal(muted.statusCode, 200, muted.body);
    assert.equal(muted.json().line.enabled, false);
    assert.equal(muted.json().line.userId, ssoLine);
    assert.equal(
      (await f.app.inject({ url: '/api/settings', headers })).statusCode,
      200,
      'admin permissions remain unchanged',
    );
    assert.equal((await f.app.inject({ url: '/api/agents', headers })).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('different Provider self-link uses verified LINE proof, enforces account ownership, and preserves staff permissions', async () => {
  const f = await fixture(false);
  try {
    const flow = await f.login();
    const headers = { cookie: sessionCookie(flow.response), origin: f.config.origin };
    const proof = {
      source: 'OA_LINK',
      accountId: flow.agent.id,
      expectedCurrentUserId: null,
      lineIdToken: 'synthetic-id-token'.repeat(3),
    };
    const initial = await f.app.inject({ url: '/api/account', headers });
    assert.equal(initial.json().lineManagedBySso, false);
    assert.equal(initial.json().canLinkLine, true);
    assert.equal(initial.json().line.userId, null, 'SSO UID from another Provider is not adopted');
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/account/line',
          headers: { origin: f.config.origin },
          payload: proof,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/account/line',
          headers: { ...headers, origin: 'https://foreign.example.org' },
          payload: proof,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/account/line',
          headers,
          payload: { ...proof, accountId: randomUUID() },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/account/line',
          headers,
          payload: { ...proof, userId: ssoLine },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/account/line',
          headers,
          payload: { ...proof, lineIdToken: 'invalid-line-token'.repeat(3) },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await f.db.query('SELECT line_user_id FROM agents WHERE id=$1', [flow.agent.id]))[0]
        .line_user_id,
      null,
    );
    const linked = await f.app.inject({
      method: 'POST',
      url: '/api/account/line',
      headers,
      payload: proof,
    });
    assert.equal(linked.statusCode, 200, linked.body);
    assert.deepEqual(linked.json().line, {
      userId: localLine,
      source: 'OA_LINK',
      verified: true,
      enabled: true,
    });
    assert.equal((await f.app.inject({ url: '/api/conversations', headers })).statusCode, 200);
    assert.equal(
      (await f.app.inject({ url: '/api/settings', headers })).statusCode,
      403,
      'self service does not grant admin rights',
    );
    const old = await f.app.inject({
      method: 'DELETE',
      url: '/api/account/line',
      headers,
      payload: { accountId: flow.agent.id, expectedCurrentUserId: null },
    });
    assert.equal(old.statusCode, 409, 'stale tab cannot remove a new binding');
    assert.equal(
      (
        await f.app.inject({
          method: 'PATCH',
          url: '/api/account/line',
          headers,
          payload: { accountId: randomUUID(), expectedCurrentUserId: localLine, enabled: false },
        })
      ).statusCode,
      403,
    );
    const removed = await f.app.inject({
      method: 'DELETE',
      url: '/api/account/line',
      headers,
      payload: { accountId: flow.agent.id, expectedCurrentUserId: localLine },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().line.userId, null);
    assert.equal(removed.json().line.enabled, false);
    assert.equal(
      (await f.app.inject({ url: '/api/conversations', headers })).statusCode,
      200,
      'unlink leaves the staff session usable',
    );
  } finally {
    await f.close();
  }
});

test('self relink prevents duplicate ownership, preserves opt-out and cancels pending private notifications', async () => {
  const f = await fixture(false);
  try {
    const flow = await f.login({ lineIdToken: 'synthetic-id-token'.repeat(3) });
    const headers = { cookie: sessionCookie(flow.response), origin: f.config.origin };
    await f.db.query('UPDATE agents SET line_alerts_enabled=false WHERE id=$1', [flow.agent.id]);
    const nextUid = 'U' + 'e'.repeat(32),
      otherId = randomUUID();
    await f.db.query(
      "INSERT INTO agents(id,name,email,password_hash,role,line_user_id) VALUES($1,'Other','other@example.org','unused','AGENT',$2)",
      [otherId, nextUid],
    );
    f.change({ localProofId: nextUid });
    const proof = {
      source: 'OA_LINK',
      accountId: flow.agent.id,
      expectedCurrentUserId: localLine,
      lineIdToken: 'synthetic-id-token'.repeat(3),
    };
    const conflict = await f.app.inject({
      method: 'POST',
      url: '/api/account/line',
      headers,
      payload: proof,
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    await f.db.query('UPDATE agents SET line_user_id=NULL WHERE id=$1', [otherId]);
    const { c } = await f.waiting();
    const [team] = await f.db.query("INSERT INTO teams(name) VALUES('Test team') RETURNING id");
    const [transfer] = await f.db.query(
      "INSERT INTO case_transfers(conversation_id,to_team_id,created_by,to_team_name,redacted_reason,request_id,routing_version) VALUES($1,$2,$3,'Test team','test',$4,0) RETURNING id",
      [c.id, team.id, flow.agent.id, randomUUID()],
    );
    const [notice] = await f.db.query(
      "INSERT INTO notifications(agent_id,conversation_id,transfer_id,title,line_status,line_payload) VALUES($1,$2,$3,'test','PENDING','synthetic') RETURNING id",
      [flow.agent.id, c.id, transfer.id],
    );
    const updated = await f.app.inject({
      method: 'POST',
      url: '/api/account/line',
      headers,
      payload: proof,
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().line.userId, nextUid);
    assert.equal(updated.json().line.enabled, false, 'relink preserves opt-out');
    const [n] = await f.db.query('SELECT line_status,line_payload FROM notifications WHERE id=$1', [
      notice.id,
    ]);
    assert.equal(n.line_status, 'CANCELLED');
    assert.equal(n.line_payload, null);
    const again = await f.login();
    assert.equal(
      again.agent.line_user_id,
      nextUid,
      'ordinary login does not overwrite a different-Provider binding',
    );
  } finally {
    await f.close();
  }
});
