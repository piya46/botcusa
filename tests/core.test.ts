import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, type Config } from '../server/config.js';
import { openDatabase, type Database, enqueue } from './database.js';
import { seed, DEMO_AGENTS } from '../server/seed.js';
import { buildApp } from '../server/app.js';
import { Worker } from '../server/worker.js';
import { decrypt, encrypt, redact, validLineSignature } from '../server/security.js';
import { claimCase, closeCase, sendAgentMessage } from '../server/conversations.js';
import {
  createExample,
  reviewExample,
  createDataset,
  revokeMessageData,
  splitForConversation,
} from '../server/training.js';
import { exchangeCusa } from '../server/sso.js';
import type { Agent } from '../shared/types.js';
import type { FastifyInstance } from 'fastify';

let db: Database, config: Config, app: FastifyInstance, directory: string;
const admin = DEMO_AGENTS[0] as Agent,
  reviewer = DEMO_AGENTS[1] as Agent,
  agent = DEMO_AGENTS[2] as Agent;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cusa-test-'));
  config = { ...getConfig({ APP_MODE: 'demo', DATA_DIR: directory }), lineSecret: 'test-secret' };
  db = await openDatabase({ memory: true });
  await seed(db, config);
  app = await buildApp(db, config, { logger: process.env.TEST_VERBOSE === '1' });
});
after(async () => {
  await app?.close();
  await db?.close();
  await rm(directory, { recursive: true, force: true });
});
async function fixture(state = 'WAITING_FOR_AGENT') {
  const [u] = await db.query(
    `INSERT INTO users(line_user_id,name,email) VALUES($1,'บุคคล ทดสอบ','private@example.org') RETURNING *`,
    ['U' + randomBytes(16).toString('hex')],
  );
  const [c] = await db.query(
    `INSERT INTO conversations(user_id,status,closed_at,assigned_agent_id,resolution) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [
      u.id,
      state,
      state === 'CLOSED' ? new Date() : null,
      ['CLOSED', 'AGENT_IN_CHARGE'].includes(state) ? admin.id : null,
      state === 'CLOSED' ? 'RESOLVED_HUMAN' : null,
    ],
  );
  return { user: u, conversation: c };
}
async function message(
  caseId: string,
  sender: string,
  text: string,
  extra: {
    status?: string;
    internal?: boolean;
    reply?: string;
    lineId?: string;
    metadata?: unknown;
  } = {},
) {
  const [m] = await db.query(
    `INSERT INTO messages(conversation_id,sender_type,agent_id,encrypted_text,redacted_text,delivery_status,internal,reply_token,reply_received_at,line_message_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      caseId,
      sender,
      sender === 'AGENT' ? admin.id : null,
      encrypt(text, config.encryptionKey),
      redact(text),
      extra.status ?? (sender === 'USER' ? 'RECEIVED' : 'SIMULATED'),
      extra.internal ?? false,
      extra.reply ? encrypt(extra.reply, config.encryptionKey) : null,
      extra.reply ? new Date() : null,
      extra.lineId ?? null,
      JSON.stringify(extra.metadata ?? {}),
    ],
  );
  return m;
}
async function cookieFor(id = admin.id) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/demo',
    headers: { origin: config.origin },
    payload: { agentId: id },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.cookies[0].name + '=' + response.cookies[0].value;
}

test('encryption detects tampering; masking handles Thai phone, email, national ID and known names', () => {
  const encrypted = encrypt('ข้อความลับ', config.encryptionKey);
  assert.equal(decrypt(encrypted, config.encryptionKey), 'ข้อความลับ');
  assert.ok(!encrypted.includes('ข้อความลับ'));
  const bytes = Buffer.from(encrypted, 'base64');
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => decrypt(bytes.toString('base64'), config.encryptionKey));
  const masked = redact('บุคคล ทดสอบ 081-234-5678 private@example.org 1-2345-67890-12-3', [
    'บุคคล ทดสอบ',
  ]);
  assert.ok(!masked.includes('081'));
  assert.ok(!masked.includes('private@'));
  assert.ok(!masked.includes('บุคคล'));
  assert.ok(masked.includes('[SENSITIVE_NUMBER]'));
});
test('API requires authentication, validates origin and disables unauthorized reviewer mutations', async () => {
  assert.equal((await app.inject('/api/conversations')).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/demo',
        headers: { origin: 'https://evil.example' },
        payload: {},
      })
    ).statusCode,
    403,
  );
  const cookie = await cookieFor(reviewer.id),
    { conversation: c } = await fixture();
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/conversations/${c.id}/claim`,
        headers: { origin: config.origin, cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal((await app.inject({ url: '/api/settings', headers: { cookie } })).statusCode, 403);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })).statusCode,
    403,
  );
});
test('claim is atomic: only one agent can win and the losing agent cannot send', async () => {
  const { conversation: c } = await fixture();
  const results = await Promise.allSettled([
    claimCase(db, config, admin, c.id),
    claimCase(db, config, agent, c.id),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const [updated] = await db.query('SELECT * FROM conversations WHERE id=$1', [c.id]);
  const loser =
    updated.assigned_agent_id === admin.id ? agent : ({ ...admin, role: 'AGENT' } as Agent);
  await assert.rejects(
    sendAgentMessage(db, config, loser, c.id, 'ส่งจากคนที่ไม่ได้รับงาน', false, randomUUID()),
    /กรุณารับงาน/,
  );
});
test('outgoing message and durable job commit once; internal notes never create delivery jobs', async () => {
  const { conversation: c } = await fixture('AGENT_IN_CHARGE');
  const clientId = randomUUID();
  const a = await sendAgentMessage(
    db,
    config,
    admin,
    c.id,
    'คำตอบที่ถูกบันทึกก่อนส่ง',
    false,
    clientId,
  );
  const b = await sendAgentMessage(
    db,
    config,
    admin,
    c.id,
    'คำตอบที่ถูกบันทึกก่อนส่ง',
    false,
    clientId,
  );
  assert.equal(a.id, b.id);
  assert.equal(
    (await db.query(`SELECT * FROM jobs WHERE dedupe_key=$1`, [`delivery:${a.id}`])).length,
    1,
  );
  const note = await sendAgentMessage(
    db,
    config,
    admin,
    c.id,
    'บันทึกสำหรับทีมเท่านั้น',
    true,
    randomUUID(),
  );
  assert.equal(
    (await db.query(`SELECT * FROM jobs WHERE dedupe_key=$1`, [`delivery:${note.id}`])).length,
    0,
  );
  const worker = new Worker(db, config);
  await worker.deliver(a.id);
  assert.equal(
    (await db.query(`SELECT delivery_status FROM messages WHERE id=$1`, [a.id]))[0].delivery_status,
    'SIMULATED',
  );
});
test('webhook verifies exact raw bytes and deduplicates redelivery before acknowledgement', async () => {
  const event = {
    webhookEventId: randomUUID(),
    type: 'message',
    source: { type: 'user', userId: 'U' + randomBytes(16).toString('hex') },
    timestamp: Date.now(),
    message: { id: randomUUID(), type: 'text', text: 'ขอติดต่อเจ้าหน้าที่' },
  };
  const payload = JSON.stringify({ events: [event] }, null, 2),
    signature = createHmac('sha256', config.lineSecret).update(payload).digest('base64');
  const headers = { 'content-type': 'application/json', 'x-line-signature': signature };
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/webhook', headers, payload })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/webhook', headers, payload })).statusCode,
    200,
  );
  assert.equal(
    (await db.query(`SELECT * FROM jobs WHERE dedupe_key=$1`, [`webhook:${event.webhookEventId}`]))
      .length,
    1,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/webhook',
        headers,
        payload: JSON.stringify({ events: [event] }),
      })
    ).statusCode,
    401,
  );
  const worker = new Worker(db, config);
  await worker.processWebhook(event.webhookEventId);
  await worker.processWebhook(event.webhookEventId);
  const rows = await db.query(`SELECT * FROM messages WHERE line_message_id=$1`, [
    event.message.id,
  ]);
  assert.equal(rows.length, 1);
  await worker.botReply(rows[0].id);
  assert.equal(
    (await db.query(`SELECT status FROM conversations WHERE id=$1`, [rows[0].conversation_id]))[0]
      .status,
    'WAITING_FOR_AGENT',
  );
  assert.equal(
    (
      await db.query(`SELECT encrypted_payload FROM webhook_events WHERE id=$1`, [
        event.webhookEventId,
      ])
    )[0].encrypted_payload,
    null,
  );
});
test('a bot response queued before human takeover is cancelled', async () => {
  const { conversation: c } = await fixture('BOT');
  const m = await message(c.id, 'BOT', 'คำตอบที่ยังอยู่ในคิว', { status: 'QUEUED' });
  await claimCase(db, config, admin, c.id);
  await new Worker(db, config).deliver(m.id);
  assert.equal(
    (await db.query(`SELECT delivery_status FROM messages WHERE id=$1`, [m.id]))[0].delivery_status,
    'CANCELLED',
  );
});
test('ambiguous Reply failure becomes UNKNOWN and never falls back to Push or retries Reply', async () => {
  const { conversation: c } = await fixture('AGENT_IN_CHARGE');
  await message(c.id, 'USER', 'คำถาม', { reply: 'reply-token' });
  const m = await message(c.id, 'AGENT', 'คำตอบ', { status: 'QUEUED' });
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw new Error('timeout');
  }) as typeof fetch;
  const worker = new Worker(
    db,
    { ...config, demo: false, lineToken: 'test-access-token' },
    fetcher,
  );
  await worker.deliver(m.id);
  await worker.deliver(m.id);
  assert.equal(calls, 1);
  assert.equal(
    (await db.query(`SELECT delivery_status FROM messages WHERE id=$1`, [m.id]))[0].delivery_status,
    'UNKNOWN',
  );
});
test('Push retries reuse the same LINE retry key; ACCEPTED does not claim delivery to the user', async () => {
  const { conversation: c } = await fixture('AGENT_IN_CHARGE'),
    m = await message(c.id, 'AGENT', 'คำตอบ', { status: 'QUEUED' });
  const keys: string[] = [];
  const fetcher = (async (_url: unknown, init: any) => {
    keys.push(init.headers['X-Line-Retry-Key']);
    if (keys.length === 1) throw new Error('timeout');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const worker = new Worker(db, { ...config, demo: false, lineToken: 'test' }, fetcher);
  await assert.rejects(worker.deliver(m.id));
  await worker.deliver(m.id);
  assert.deepEqual(keys, [m.id, m.id]);
  assert.equal(
    (await db.query(`SELECT delivery_status FROM messages WHERE id=$1`, [m.id]))[0].delivery_status,
    'ACCEPTED',
  );
});
test('redelivered messages older than twenty minutes use Push instead of an expired Reply token', async () => {
  const { conversation: c } = await fixture('AGENT_IN_CHARGE');
  const source = await message(c.id, 'USER', 'คำถามส่งมาแล้ว', { reply: 'old-reply-token' });
  await db.query(`UPDATE messages SET created_at=now()-interval '21 minutes' WHERE id=$1`, [
    source.id,
  ]);
  const outgoing = await message(c.id, 'AGENT', 'คำตอบเจ้าหน้าที่', { status: 'QUEUED' });
  const requests: string[] = [];
  const fetcher = (async (url: unknown) => {
    requests.push(String(url));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  await new Worker(db, { ...config, demo: false, lineToken: 'test' }, fetcher).deliver(outgoing.id);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].endsWith('/v2/bot/message/push'));
  assert.equal(
    (await db.query(`SELECT delivery_status FROM messages WHERE id=$1`, [outgoing.id]))[0]
      .delivery_status,
    'ACCEPTED',
  );
});
test('training preserves context, excludes internal and failed messages, and requires a second reviewer', async () => {
  const { conversation: c } = await fixture('AGENT_IN_CHARGE');
  await message(c.id, 'USER', 'บุคคล ทดสอบ อีเมล private@example.org โทร 0812345678 ขอสอบถามครับ');
  await message(c.id, 'BOT', 'กรุณาระบุรายละเอียดเพิ่มได้เลยค่ะ');
  await message(c.id, 'USER', 'จะเข้าสู่ระบบได้อย่างไรครับ');
  await message(c.id, 'AGENT', 'โน้ตลับไม่ใช่คำตอบ', { internal: true });
  await message(c.id, 'AGENT', 'ข้อความที่ยังส่งไม่สำเร็จ', { status: 'FAILED' });
  await message(c.id, 'AGENT', 'กดปุ่มยืนยันตัวตนใน LINE แล้วเข้าสู่ระบบ CUSA SSO ด้วย Google ค่ะ');
  await assert.rejects(createExample(db, config, admin, c.id), /ปิดเคส/);
  await closeCase(db, config, admin, c.id, 'RESOLVED_HUMAN', 'ผู้ใช้ยืนยันว่าเข้าใช้งานได้แล้ว');
  const example = await createExample(db, config, admin, c.id);
  const combined = JSON.stringify(example.context);
  assert.equal(example.context.length, 3);
  assert.ok(!combined.includes('private@'));
  assert.ok(!combined.includes('081234'));
  assert.ok(!combined.includes('บุคคล ทดสอบ'));
  assert.ok(!combined.includes('โน้ตลับ'));
  assert.ok(!combined.includes('ส่งไม่สำเร็จ'));
  await assert.rejects(reviewExample(db, admin, example.id, true), /อีกคน/);
  await reviewExample(db, reviewer, example.id, true);
  const dataset = await createDataset(db, reviewer, 'Version under test');
  const [item] = await db.query(
    `SELECT * FROM dataset_items WHERE dataset_id=$1 AND example_id=$2`,
    [dataset.id, example.id],
  );
  assert.equal(item.snapshot.messages.length, 4);
  assert.equal(item.split, splitForConversation(c.id));
  const cookie = await cookieFor(reviewer.id);
  const exported = await app.inject({
    url: `/api/datasets/${dataset.id}/export`,
    headers: { cookie },
  });
  assert.equal(exported.statusCode, 200);
  assert.ok(exported.body.includes(example.id));
  await db.transaction((tx) => revokeMessageData(tx, example.source_message_ids[0]));
  const withdrawn = await app.inject({
    url: `/api/datasets/${dataset.id}/export`,
    headers: { cookie },
  });
  assert.ok(!withdrawn.body.includes(example.id));
  assert.equal(
    (
      await db.query(`SELECT snapshot FROM dataset_items WHERE dataset_id=$1 AND example_id=$2`, [
        dataset.id,
        example.id,
      ])
    )[0].snapshot,
    null,
  );
});
test('an unsend arriving before its original message prevents content from being retained', async () => {
  const worker = new Worker(db, config),
    lineId = 'U' + randomBytes(16).toString('hex'),
    lineMessage = randomUUID();
  const events = [
    {
      type: 'unsend',
      source: { type: 'user', userId: lineId },
      unsend: { messageId: lineMessage },
    },
    {
      type: 'message',
      source: { type: 'user', userId: lineId },
      message: { id: lineMessage, type: 'text', text: 'ข้อความที่ถอนแล้ว' },
    },
  ];
  for (const event of events) {
    const id = randomUUID();
    await db.query(`INSERT INTO webhook_events(id,encrypted_payload) VALUES($1,$2)`, [
      id,
      encrypt(JSON.stringify(event), config.encryptionKey),
    ]);
    await worker.processWebhook(id);
  }
  assert.equal(
    (await db.query(`SELECT * FROM messages WHERE line_message_id=$1`, [lineMessage])).length,
    0,
  );
});
test('draft knowledge changes cannot leak into the published answer', async () => {
  const cookie = await cookieFor(),
    { id } = (
      await db.query(`SELECT id FROM knowledge WHERE published_content IS NOT NULL LIMIT 1`)
    )[0];
  const [original] = await db.query(`SELECT * FROM knowledge WHERE id=$1`, [id]);
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/knowledge/${id}`,
    headers: { cookie, origin: config.origin },
    payload: {
      title: 'ฉบับร่างใหม่',
      content: 'เนื้อหายังไม่อนุมัติ ห้ามให้บอทตอบ',
      category: 'ทั่วไป',
      keywords: ['draft-only'],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const [updated] = await db.query(`SELECT * FROM knowledge WHERE id=$1`, [id]);
  assert.equal(updated.published_content, original.published_content);
  assert.equal(updated.published_title, original.published_title);
  const publish = await app.inject({
    method: 'POST',
    url: `/api/knowledge/${id}/publish`,
    headers: { cookie, origin: config.origin },
    payload: {},
  });
  assert.equal(publish.statusCode, 403);
});
test('CUSA v1.4 exchange uses JSON, validates audience and handles optional unconsented claims', async () => {
  const client = randomUUID(),
    calls: { url: string; init: any }[] = [];
  const c = {
    ...config,
    ssoOrigin: 'https://sso.reunion.scicu-alumni.com',
    ssoClientId: client,
    ssoApiKey: 'backend-key',
  };
  const fetcher = (async (url: unknown, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify(
        calls.length === 1
          ? {
              access_token: 'A'.repeat(43),
              token_type: 'Bearer',
              expires_in: 300,
              scope: 'identity:read',
            }
          : { sub: randomUUID(), aud: client, roles: ['member'], scope: 'identity:read' },
      ),
      { status: 200 },
    );
  }) as typeof fetch;
  const result = await exchangeCusa(c, 'B'.repeat(43), 'C'.repeat(43), fetcher);
  assert.equal(result.name, undefined);
  assert.equal(calls[0].init.headers['X-API-Key'], 'backend-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.code_verifier, 'C'.repeat(43));
  assert.equal(body.client_id, undefined);
  assert.equal(body.redirect_uri, config.origin + '/api/auth/callback');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + 'A'.repeat(43));
  let count = 0;
  const wrongAudience = (async () => {
    count++;
    return new Response(
      JSON.stringify(
        count === 1
          ? {
              access_token: 'A'.repeat(43),
              token_type: 'Bearer',
              expires_in: 300,
              scope: 'identity:read',
            }
          : { sub: randomUUID(), aud: randomUUID(), roles: ['member'], scope: 'identity:read' },
      ),
    );
  }) as typeof fetch;
  await assert.rejects(
    exchangeCusa(c, 'B'.repeat(43), 'C'.repeat(43), wrongAudience),
    /ไม่มีสิทธิ์/,
  );
  assert.equal(count, 2);
});
test('live configuration fails closed; demo cannot be exposed to a network interface', () => {
  assert.throws(() => getConfig({ APP_MODE: 'live', DATA_DIR: directory }), /Live mode requires/);
  assert.throws(
    () => getConfig({ APP_MODE: 'demo', HOST: '0.0.0.0', DATA_DIR: directory }),
    /loopback/,
  );
});

test('editing a training draft preserves earlier turns and refreshes authorship for maker-checker', async () => {
  const { conversation: c } = await fixture('CLOSED');
  await message(c.id, 'USER', 'คำถามแรกในบริบท');
  await message(c.id, 'BOT', 'ขอข้อมูลเพิ่มเติมค่ะ');
  await message(c.id, 'USER', 'คำถามที่ต้องการคำตอบ');
  await message(c.id, 'AGENT', 'คำตอบสุดท้ายที่แก้ปัญหาได้');
  const example = await createExample(db, config, admin, c.id),
    cookie = await cookieFor(reviewer.id);
  const result = await app.inject({
    method: 'PATCH',
    url: `/api/training/${example.id}`,
    headers: { cookie, origin: config.origin },
    payload: {
      question: 'คำถามที่ปรับให้อ่านง่าย',
      answer: 'คำตอบที่ตรวจแก้แล้วอย่างถูกต้อง',
      notes: 'ปรับภาษา',
    },
  });
  assert.equal(result.statusCode, 200, result.body);
  const edited = result.json();
  assert.equal(edited.context.length, 3);
  assert.equal(edited.context[0].content, 'คำถามแรกในบริบท');
  assert.equal(edited.context[2].content, 'คำถามที่ปรับให้อ่านง่าย');
  assert.equal(edited.created_by, reviewer.id);
  await assert.rejects(reviewExample(db, reviewer, example.id, true), /อีกคน/);
  const approval = await app.inject({
    method: 'POST',
    url: `/api/training/${example.id}/review`,
    headers: { cookie: await cookieFor(admin.id), origin: config.origin },
    payload: { approve: true },
  });
  assert.equal(approval.statusCode, 400);
});

test('SSO callback binds the verified LINE identity, consumes state once, and ignores client-supplied identity', async () => {
  const client = randomUUID(),
    sub = randomUUID(),
    verifiedLine = 'U' + randomBytes(16).toString('hex');
  let exchanges = 0;
  const live = {
    ...config,
    demo: false,
    origin: 'https://bot.example.org',
    ssoOrigin: 'https://sso.reunion.scicu-alumni.com',
    ssoClientId: client,
    ssoApiKey: 'test-key',
    lineLoginChannelId: '123456',
    liffId: '123456-test',
  };
  const fetcher = (async (url: unknown) => {
    const path = String(url);
    if (path.includes('api.line.me/oauth2'))
      return Response.json({
        sub: verifiedLine,
        aud: live.lineLoginChannelId,
        iss: 'https://access.line.me',
        exp: Math.floor(Date.now() / 1000) + 60,
      });
    if (path.endsWith('/token')) {
      exchanges++;
      return Response.json({
        access_token: 'A'.repeat(43),
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'identity:read',
      });
    }
    if (path.endsWith('/userinfo'))
      return Response.json({ sub, aud: client, roles: ['member'], scope: 'identity:read' });
    throw new Error('Unexpected provider request');
  }) as typeof fetch;
  const ssoApp = await buildApp(db, live, { fetcher });
  try {
    assert.equal(
      (
        await ssoApp.inject({
          method: 'POST',
          url: '/api/auth/demo',
          headers: { origin: live.origin },
          payload: {},
        })
      ).statusCode,
      404,
    );
    const start = await ssoApp.inject({
      method: 'POST',
      url: '/api/connect/start',
      headers: { origin: live.origin },
      payload: {
        idToken: 'test-signed-id-token-for-line',
        lineUserId: 'U00000000000000000000000000000000',
      },
    });
    assert.equal(start.statusCode, 200, start.body);
    const url = new URL(start.json().url),
      state = url.searchParams.get('state')!,
      cookie = start.cookies[0];
    assert.equal(url.pathname, '/api/sso/authorize');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(cookie.secure);
    assert.ok(cookie.httpOnly);
    const callback = `/api/auth/callback?state=${state}&code=${'B'.repeat(43)}`;
    const wrongCookie = await ssoApp.inject({
      url: callback,
      headers: { cookie: 'cusa_link=invalid' },
    });
    assert.equal(wrongCookie.headers.location, '/connect?result=invalid');
    assert.equal(exchanges, 0);
    const success = await ssoApp.inject({
      url: callback,
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(success.headers.location, '/connect?result=success');
    assert.equal(exchanges, 1);
    const [user] = await db.query(`SELECT * FROM users WHERE cusa_sub=$1`, [sub]);
    assert.equal(user.line_user_id, verifiedLine);
    assert.equal(user.email, null);
    const replay = await ssoApp.inject({
      url: callback,
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(replay.headers.location, '/connect?result=invalid');
    assert.equal(exchanges, 1);
  } finally {
    await ssoApp.close();
  }
});

test('attachments require authentication and PNG/JPEG validation, are encrypted, and remain in transcript', async () => {
  const { conversation: c } = await fixture('AGENT_IN_CHARGE'),
    cookie = await cookieFor();
  const boundary = '----test-boundary';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k/gAAAABJRU5ErkJggg==',
    'base64',
  );
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/conversations/${c.id}/image`,
    headers: {
      origin: config.origin,
      cookie,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  const [m] = await db.query(`SELECT * FROM messages WHERE id=$1`, [response.json().id]);
  assert.ok(m.attachment_id);
  assert.equal((await app.inject(`/api/attachments/${m.attachment_id}`)).statusCode, 401);
  const image = await app.inject({
    url: `/api/attachments/${m.attachment_id}`,
    headers: { cookie },
  });
  assert.equal(image.statusCode, 200);
  assert.deepEqual(image.rawPayload, png);
  const transcript = await app.inject({
    url: `/api/conversations/${c.id}/transcript`,
    headers: { cookie },
  });
  assert.equal(transcript.json().messages[0].attachment_id, m.attachment_id);
});

test('persistent PostgreSQL data and encryption key survive reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cusa-persistence-'));
  try {
    const first = getConfig({ APP_MODE: 'demo', DATA_DIR: dir });
    let persistent = await openDatabase({ dataDir: dir });
    await persistent.query(`INSERT INTO settings(key,value) VALUES('persistence_check',$1)`, [
      JSON.stringify(encrypt('เก็บข้อมูลข้ามการเปิดโปรแกรม', first.encryptionKey)),
    ]);
    await persistent.close();
    const second = getConfig({ APP_MODE: 'demo', DATA_DIR: dir });
    persistent = await openDatabase({ dataDir: dir });
    const [saved] = await persistent.query(
      `SELECT value FROM settings WHERE key='persistence_check'`,
    );
    assert.equal(decrypt(saved.value, second.encryptionKey), 'เก็บข้อมูลข้ามการเปิดโปรแกรม');
    await persistent.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
