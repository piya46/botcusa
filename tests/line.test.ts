import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Agent } from '../shared/types.js';
import { getConfig, type Config } from '../server/config.js';
import { openDatabase, type Database } from './database.js';
import { buildApp } from '../server/app.js';
import { DEMO_AGENTS } from '../server/seed.js';
import { configureAgentLine, deliverTransferLine } from '../server/line-notifications.js';
import { saveTeam, transferCase } from '../server/tickets.js';
import { showLineLoading } from '../server/providers.js';
import { Worker } from '../server/worker.js';
import { encrypt } from '../server/security.js';

let db: Database, config: Config, app: FastifyInstance, directory: string;
const admin = DEMO_AGENTS[0] as Agent,
  agent = DEMO_AGENTS[2] as Agent;
const recipient = () => 'U' + randomBytes(16).toString('hex');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cusa-line-'));
  config = getConfig({ APP_MODE: 'demo', DATA_DIR: directory });
  db = await openDatabase({ memory: true });
  for (const a of DEMO_AGENTS)
    await db.query(
      `INSERT INTO agents(id,name,email,role,password_hash) VALUES($1,$2,$3,$4,'unused')`,
      [a.id, a.name, a.email, a.role],
    );
  app = await buildApp(db, config);
});
after(async () => {
  await app.close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});
async function login(id: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/demo',
    headers: { origin: config.origin },
    payload: { agentId: id },
  });
  return `${r.cookies[0].name}=${r.cookies[0].value}`;
}
async function conversation(question = 'zqxmanual') {
  const [u] = await db.query(
    `INSERT INTO users(line_user_id,name) VALUES($1,'ทดสอบ LINE') RETURNING *`,
    [recipient()],
  );
  const [c] = await db.query(`INSERT INTO conversations(user_id) VALUES($1) RETURNING *`, [u.id]);
  const [m] = await db.query(
    `INSERT INTO messages(conversation_id,sender_type,encrypted_text,redacted_text) VALUES($1,'USER',$2,$3) RETURNING *`,
    [c.id, encrypt(question, config.encryptionKey), question],
  );
  return { u, c, m };
}
async function transferFixture(named = true) {
  await configureAgentLine(db, admin, admin.id, { userId: recipient(), enabled: true });
  await configureAgentLine(db, admin, agent.id, { userId: recipient(), enabled: true });
  const team = await saveTeam(db, admin, {
    name: 'LINE team ' + randomUUID(),
    description: '',
    memberIds: [admin.id, agent.id],
    active: true,
  });
  const { c } = await conversation();
  const input = {
    teamId: team.id!,
    agentId: named ? agent.id : null,
    reason: 'เหตุผลส่วนตัวที่ไม่ควรถูกส่งเข้า LINE',
    expectedVersion: 0,
    requestId: randomUUID(),
  };
  const result = await transferCase(db, config, admin, c.id, input);
  return {
    c,
    team,
    input,
    result,
    notices: await db.query(`SELECT * FROM notifications WHERE transfer_id=$1`, [result.id]),
  };
}

test('loading sends the documented body before AI, uses no reply/retry token, and failures do not block answers', async () => {
  const cfg = {
    ...config,
    demo: false,
    lineToken: 'test-token',
    geminiKey: 'test-key',
    geminiModel: 'test-model',
  };
  const { u, c, m } = await conversation();
  await db.query(
    `INSERT INTO knowledge(title,content,category,keywords,published_title,published_content,published_keywords,status,created_by,updated_by) VALUES('zqxmanual','คำตอบทางการ','ทั่วไป','["zqxmanual"]','zqxmanual','คำตอบทางการ','["zqxmanual"]','PUBLISHED',$1,$1)`,
    [admin.id],
  );
  const paths: string[] = [];
  const worker = new Worker(db, cfg, async (url, init) => {
    paths.push(String(url));
    if (String(url).includes('/loading/start')) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        chatId: u.line_user_id,
        loadingSeconds: 30,
      });
      assert.equal((init?.headers as Record<string, string>)['X-Line-Retry-Key'], undefined);
      return new Response('{}', { status: 503 });
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'คำตอบจาก AI ที่ตรวจสอบแล้ว' }] } }],
      }),
      { status: 200 },
    );
  });
  await worker.botReply(m.id);
  assert.ok(paths[0].endsWith('/v2/bot/chat/loading/start'));
  assert.ok(paths[1].includes(':generateContent'));
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type='BOT'`,
        [c.id],
      )
    )[0].n,
    1,
  );
  await worker.botReply(m.id);
  assert.equal(paths.length, 2);
});

test('loading is bounded, respects demo and disabled modes, and excludes old messages and staff cases', async () => {
  const id = recipient();
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response('{}', { status: 202 });
  };
  assert.equal(await showLineLoading(config, id, fetcher), 'SIMULATED');
  assert.equal(calls, 0);
  assert.equal(
    await showLineLoading(
      { ...config, demo: false, lineToken: 'test', lineLoadingEnabled: false },
      id,
      fetcher,
    ),
    'SKIPPED',
  );
  assert.equal(
    await showLineLoading(
      { ...config, demo: false, lineToken: 'test' },
      'C' + id.slice(1),
      fetcher,
    ),
    'SKIPPED',
  );
  const started = Date.now();
  const status = await showLineLoading(
    { ...config, demo: false, lineToken: 'test' },
    id,
    async (_url, init) =>
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('test deadline')), 2500);
        init!.signal!.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
  );
  assert.equal(status, 'FAILED');
  assert.ok(Date.now() - started < 2400);
  const worker = new Worker(db, { ...config, demo: false, lineToken: 'test' }, fetcher);
  const old = await conversation('unmatched-old');
  await db.query(`UPDATE messages SET created_at=now()-interval '3 minutes' WHERE id=$1`, [
    old.m.id,
  ]);
  await worker.botReply(old.m.id);
  const human = await conversation();
  await db.query(`UPDATE conversations SET status='WAITING_FOR_AGENT' WHERE id=$1`, [human.c.id]);
  await worker.botReply(human.m.id);
  const explicit = await conversation('ขอคุยกับคน');
  await worker.botReply(explicit.m.id);
  assert.equal(calls, 0);
  assert.throws(
    () => getConfig({ APP_MODE: 'demo', DATA_DIR: directory, LINE_LOADING_SECONDS: '17' }),
    /increments/,
  );
});

test('staff LINE settings are admin-only, validate identity, and private queued payloads are not returned by APIs', async () => {
  const url = `/api/agents/${agent.id}/line-notifications`;
  let cookie = await login(agent.id);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie, origin: config.origin },
        payload: { userId: recipient(), enabled: true },
      })
    ).statusCode,
    403,
  );
  cookie = await login(admin.id);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie, origin: config.origin },
        payload: { userId: '@display-id', enabled: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie, origin: config.origin },
        payload: { userId: null, enabled: true },
      })
    ).statusCode,
    400,
  );
  const f = await transferFixture();
  cookie = await login(agent.id);
  const result = (await app.inject({ url: '/api/notifications', headers: { cookie } })).json();
  assert.ok(result.items.some((n: any) => n.id === f.notices[0].id));
  assert.ok(!result.items.some((n: any) => 'line_payload' in n));
  assert.equal(
    (await app.inject({ url: '/api/line-notifications', headers: { cookie } })).statusCode,
    403,
  );
});

test('named and team transfer recipients are queued atomically; retries preserve the body/key and duplicate transfers cannot resend', async () => {
  const f = await transferFixture();
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].agent_id, agent.id);
  assert.equal(f.notices[0].line_status, 'PENDING');
  assert.ok(!f.notices[0].line_payload.includes('มีงานส่งต่อ'));
  await transferCase(db, config, admin, f.c.id, f.input);
  assert.equal(
    (
      await db.query(
        `SELECT id FROM jobs WHERE kind='TRANSFER_LINE_ALERT' AND payload->>'notificationId'=$1`,
        [f.notices[0].id],
      )
    ).length,
    1,
  );
  const attempts: { body: unknown; key: string }[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    attempts.push({
      body: JSON.parse(String(init?.body)),
      key: (init!.headers as Record<string, string>)['X-Line-Retry-Key'],
    });
    if (attempts.length === 1) return new Response('{}', { status: 500 });
    return new Response('{}', {
      status: 409,
      headers: { 'x-line-accepted-request-id': 'accepted' },
    });
  };
  const live = { ...config, demo: false, lineToken: 'test' };
  await assert.rejects(deliverTransferLine(db, live, f.notices[0].id, fetcher));
  await deliverTransferLine(db, live, f.notices[0].id, fetcher);
  await deliverTransferLine(db, live, f.notices[0].id, fetcher);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[0].key, f.notices[0].id);
  assert.ok(!JSON.stringify(attempts[0].body).includes(f.input.reason));
  assert.equal(
    (await db.query(`SELECT line_status FROM notifications WHERE id=$1`, [f.notices[0].id]))[0]
      .line_status,
    'ACCEPTED',
  );
  const team = await transferFixture(false);
  assert.equal(team.notices.length, 2);
  for (const n of team.notices)
    await deliverTransferLine(db, config, n.id, async () => {
      throw new Error('Demo must not call LINE');
    });
  assert.ok(
    (
      await db.query(`SELECT line_status FROM notifications WHERE transfer_id=$1`, [team.result.id])
    ).every((n) => n.line_status === 'SIMULATED'),
  );
});

test('claim, further transfer, disabled recipient and removed membership cancel pending alerts', async () => {
  const live = { ...config, demo: false, lineToken: 'test' };
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response('{}', { status: 200 });
  };
  for (const scenario of ['claimed', 'transferred', 'disabled', 'removed', 'expired']) {
    const f = await transferFixture();
    const n = f.notices[0];
    if (scenario === 'claimed')
      await db.query(`UPDATE conversations SET status='AGENT_IN_CHARGE' WHERE id=$1`, [f.c.id]);
    if (scenario === 'transferred')
      await transferCase(db, config, admin, f.c.id, {
        ...f.input,
        agentId: admin.id,
        expectedVersion: 1,
        requestId: randomUUID(),
      });
    if (scenario === 'disabled')
      await configureAgentLine(db, admin, agent.id, { userId: null, enabled: false });
    if (scenario === 'removed')
      await db.query(`DELETE FROM team_members WHERE team_id=$1 AND agent_id=$2`, [
        f.team.id,
        agent.id,
      ]);
    if (scenario === 'expired')
      await db.query(`UPDATE notifications SET created_at=now()-interval '24 hours' WHERE id=$1`, [
        n.id,
      ]);
    await deliverTransferLine(db, live, n.id, fetcher);
    assert.equal(
      (await db.query(`SELECT line_status FROM notifications WHERE id=$1`, [n.id]))[0].line_status,
      'CANCELLED',
      scenario,
    );
  }
  assert.equal(calls, 0);
});

test('permanent LINE rejection records a failure without losing the in-app notification or transfer', async () => {
  const f = await transferFixture();
  await db.query(`UPDATE jobs SET run_at=now()+interval '1 day' WHERE status='PENDING'`);
  await db.query(
    `UPDATE jobs SET run_at=now() WHERE kind='TRANSFER_LINE_ALERT' AND payload->>'notificationId'=$1`,
    [f.notices[0].id],
  );
  const worker = new Worker(
    db,
    { ...config, demo: false, lineToken: 'test' },
    async () => new Response('{}', { status: 400 }),
  );
  await worker.runOne();
  const [n] = await db.query(`SELECT * FROM notifications WHERE id=$1`, [f.notices[0].id]);
  assert.equal(n.line_status, 'FAILED');
  assert.equal(n.read_at, null);
  assert.equal(n.line_payload, null);
  assert.equal(
    (await db.query(`SELECT status FROM conversations WHERE id=$1`, [f.c.id]))[0].status,
    'WAITING_FOR_AGENT',
  );
});
