import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../server/config.js';
import { openDatabase } from './database.js';
import { buildApp } from '../server/app.js';
import { Worker } from '../server/worker.js';
import { DEMO_AGENTS } from '../server/seed.js';

const groupId = 'C' + 'a'.repeat(32);
async function fixture(recipient = groupId) {
  const root = await mkdtemp(join(tmpdir(), 'cusa-line-groups-'));
  const config = getConfig({
    APP_MODE: 'demo',
    DATA_DIR: root,
    LINE_CHANNEL_SECRET: 'test-line-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
    LINE_AGENT_ALERT_USER_ID: recipient,
    LINE_SUPERVISOR_ALERT_USER_ID: groupId,
    LINE_LOADING_ENABLED: 'false',
  });
  const db = await openDatabase({ memory: true });
  for (const agent of DEMO_AGENTS)
    await db.query(
      "INSERT INTO agents(id,name,email,role,password_hash) VALUES($1,$2,$3,$4,'unused')",
      [agent.id, agent.name, agent.email, agent.role],
    );
  const app = await buildApp(db, config);
  const calls: { path: string; body: any; retry: string | undefined }[] = [];
  let pushStatus = 200;
  const worker = new Worker(db, { ...config, demo: false }, (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/v2/bot/profile/'))
      return Response.json({ userId: path.split('/').pop(), displayName: 'ชื่อ LINE ทดสอบ' });
    assert.ok(['/v2/bot/message/push', '/v2/bot/message/reply'].includes(path));
    calls.push({
      path,
      body: JSON.parse(String(init?.body)),
      retry: (init?.headers as Record<string, string>)['X-Line-Retry-Key'],
    });
    const status = path.endsWith('/push') ? pushStatus : 200;
    return new Response('{}', {
      status,
      headers: status === 409 ? { 'x-line-accepted-request-id': 'original-request' } : {},
    });
  }) as typeof fetch);
  const login = async (agentId = DEMO_AGENTS[0].id) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin: config.origin },
      payload: { agentId },
    });
    return r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  };
  const cookie = await login();
  const sendEvent = async (event: object, signatureValid = true) => {
    const payload = JSON.stringify({ events: [event] });
    return app.inject({
      method: 'POST',
      url: '/api/webhook',
      headers: {
        'content-type': 'application/json',
        'x-line-signature': createHmac('sha256', signatureValid ? config.lineSecret : 'wrong')
          .update(payload)
          .digest('base64'),
      },
      payload,
    });
  };
  const handover = async (text = 'ขอคุยกับคน ส่งต่อเลย รายละเอียดส่วนตัว 0891234567') => {
    const event = {
      webhookEventId: randomUUID(),
      type: 'message',
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U' + randomBytes(16).toString('hex') },
      replyToken: 'synthetic-reply',
      message: { id: randomUUID(), type: 'text', text },
    };
    assert.equal((await sendEvent(event)).statusCode, 200);
    await worker.tick();
    const [c] = await db.query(
      'SELECT c.* FROM conversations c JOIN users u ON u.id=c.user_id WHERE u.line_user_id=$1',
      [event.source.userId],
    );
    return { event, c };
  };
  const status = async () => {
    const response = await app.inject({ url: '/api/line-alerts', headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  return {
    root,
    config,
    db,
    app,
    worker,
    calls,
    cookie,
    login,
    sendEvent,
    handover,
    status,
    setPushStatus: (value: number) => {
      pushStatus = value;
    },
    close: async () => {
      await worker.stop();
      await app.close();
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('new handover sends a minimal group Push once; later messages do not re-alert and status is visible', async () => {
  const f = await fixture();
  try {
    const { event, c } = await f.handover();
    assert.equal(c.status, 'WAITING_FOR_AGENT');
    const pushes = f.calls.filter((c) => c.path.endsWith('/push'));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].body.to, groupId);
    assert.match(pushes[0].body.messages[0].altText, /มีเคสรอเจ้าหน้าที่/);
    assert.ok(JSON.stringify(pushes[0].body.messages[0].contents).includes(c.id));
    assert.ok(!JSON.stringify(pushes[0].body).includes('0891234567'));
    assert.ok(pushes[0].retry);
    assert.ok(f.calls.some((c) => c.path.endsWith('/reply')));
    await f.sendEvent(event);
    await f.sendEvent({
      ...event,
      webhookEventId: randomUUID(),
      message: { ...event.message, id: randomUUID(), text: 'เพิ่มเติม' },
    });
    await f.worker.tick();
    assert.equal(f.calls.filter((c) => c.path.endsWith('/push')).length, 1);
    const result = await f.status();
    assert.deepEqual(result.agent, { id: groupId, type: 'group', configured: true });
    assert.equal(result.jobs[0].status, 'DONE');
    assert.ok(result.jobs[0].accepted);
    assert.equal(result.jobs[0].last_error, null);
    assert.ok(!JSON.stringify(result).includes(f.config.lineToken));
  } finally {
    await f.close();
  }
});

test('intake replies to the user first and alerts the group only once the case is handed over', async () => {
  const f = await fixture();
  try {
    const { event, c } = await f.handover('ขอคุยกับคนครับ');
    assert.equal(c.status, 'BOT');
    assert.equal(f.calls.filter((call) => call.body.to === groupId).length, 0);
    assert.ok(f.calls.some((call) => call.path.endsWith('/reply')));
    await f.sendEvent({
      ...event,
      webhookEventId: randomUUID(),
      message: { ...event.message, id: randomUUID(), text: 'ไม่สะดวกให้ข้อมูล ส่งต่อเลย' },
    });
    await f.worker.tick();
    assert.equal(f.calls.filter((call) => call.body.to === groupId).length, 1);
    assert.equal(
      (await f.db.query('SELECT status FROM conversations WHERE id=$1', [c.id]))[0].status,
      'WAITING_FOR_AGENT',
    );
  } finally {
    await f.close();
  }
});

test('group Push retries preserve destination/body/retry key, and definitive rejection stays visible', async () => {
  const f = await fixture();
  try {
    f.setPushStatus(500);
    const { c } = await f.handover();
    const [job] = await f.db.query(
      "SELECT * FROM jobs WHERE kind='ALERT' AND payload->>'conversationId'=$1",
      [c.id],
    );
    assert.equal(job.status, 'PENDING');
    f.setPushStatus(409);
    await f.db.query('UPDATE jobs SET run_at=$2 WHERE id=$1', [
      job.id,
      new Date(Date.now() - 1000),
    ]);
    await f.worker.tick();
    const pushes = f.calls.filter((c) => c.path.endsWith('/push'));
    assert.equal(pushes.length, 2);
    assert.deepEqual(pushes[0], pushes[1]);
    assert.ok((await f.status()).jobs[0].accepted);
    f.setPushStatus(400);
    const failed = await f.handover();
    const record = (await f.status()).jobs.find((j: any) => j.conversation_id === failed.c.id);
    assert.equal(record.status, 'FAILED');
    assert.match(record.last_error, /400/);
    assert.ok(!record.accepted);
  } finally {
    await f.close();
  }
});

test('unconfigured central alerts show a skipped reason and do not block the member reply', async () => {
  const f = await fixture('');
  try {
    await f.handover();
    assert.equal(f.calls.filter((c) => c.path.endsWith('/push')).length, 0);
    assert.equal(f.calls.filter((c) => c.path.endsWith('/reply')).length, 1);
    const result = await f.status();
    assert.equal(result.agent.configured, false);
    assert.match(result.jobs[0].last_error, /ยังไม่ได้ตั้งผู้รับ/);
    assert.ok(!result.jobs[0].accepted);
  } finally {
    await f.close();
  }
});

test('only signed group metadata is discoverable by admins; messages are discarded and old events cannot undo leave', async () => {
  const f = await fixture();
  try {
    const at = Date.now();
    const groupEvent = (type: string, timestamp: number) => ({
      webhookEventId: randomUUID(),
      type,
      timestamp,
      source: { type: 'group', groupId },
      message: { id: randomUUID(), type: 'text', text: 'private group conversation' },
    });
    const rejected = groupEvent('join', at);
    assert.equal((await f.sendEvent(rejected, false)).statusCode, 401);
    assert.equal((await f.db.query('SELECT * FROM line_chats')).length, 0);
    for (const event of [
      groupEvent('join', at),
      groupEvent('message', at + 1000),
      groupEvent('leave', at + 2000),
      groupEvent('message', at + 500),
    ]) {
      assert.equal((await f.sendEvent(event)).statusCode, 200);
      await f.worker.tick();
    }
    const result = await f.status();
    assert.equal(result.chats.length, 1);
    assert.equal(result.chats[0].id, groupId);
    assert.equal(result.chats[0].active, false);
    assert.equal(new Date(result.chats[0].last_event_at).getTime(), at + 2000);
    assert.equal((await f.db.query('SELECT * FROM conversations')).length, 0);
    assert.equal((await f.db.query('SELECT * FROM messages')).length, 0);
    assert.ok(
      (await f.db.query('SELECT encrypted_payload FROM webhook_events')).every(
        (r) => r.encrypted_payload === null,
      ),
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.app.inject('/api/line-alerts')).statusCode, 401);
    for (const id of [DEMO_AGENTS[1].id, DEMO_AGENTS[2].id])
      assert.equal(
        (await f.app.inject({ url: '/api/line-alerts', headers: { cookie: await f.login(id) } }))
          .statusCode,
        403,
      );
    await f.sendEvent(groupEvent('join', at + 3000));
    await f.worker.tick();
    assert.equal((await f.status()).chats[0].active, true);
  } finally {
    await f.close();
  }
});

test('supervisor alerts can target the group and a claimed case cancels its queued initial alert', async () => {
  const f = await fixture();
  try {
    const { c } = await f.handover();
    await f.db.query('UPDATE conversations SET handover_at=$2 WHERE id=$1', [
      c.id,
      new Date(Date.now() - 6 * 60_000),
    ]);
    await f.worker.queueOverdueAlerts();
    await f.worker.tick();
    const pushes = f.calls.filter((c) => c.path.endsWith('/push'));
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].body.to, groupId);
    assert.match(pushes[1].body.messages[0].altText, /เคสรอเกิน 5 นาที/);
    await f.db.query(
      "UPDATE conversations SET status='AGENT_IN_CHARGE',assigned_agent_id=$2 WHERE id=$1",
      [c.id, DEMO_AGENTS[0].id],
    );
    assert.equal(await f.worker.alert(c.id, randomUUID()), 'CANCELLED');
    assert.equal(f.calls.filter((c) => c.path.endsWith('/push')).length, 2);
  } finally {
    await f.close();
  }
});
