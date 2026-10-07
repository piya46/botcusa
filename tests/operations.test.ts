import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getConfig, type Config } from '../server/config.js';
import { openDatabase, type Database } from './database.js';
import { buildApp } from '../server/app.js';
import { DEMO_AGENTS } from '../server/seed.js';
import { audienceBody, audienceCount, audienceRecipients } from '../server/audiences.js';
import { queueRichMenu, demoRichMenus } from '../server/rich-menus.js';
import { Worker } from '../server/worker.js';
import { claimCase, sendAgentMessage, closeCase, getMessages } from '../server/conversations.js';
import { saveTeam, transferCase, transferHistory } from '../server/tickets.js';
import { tokenHash } from '../server/security.js';
import { operationalStats } from '../server/stats.js';
import type { Agent } from '../shared/types.js';

let db: Database, app: FastifyInstance, config: Config, directory: string, cookie: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cusa-operations-'));
  config = getConfig({ APP_MODE: 'demo', DATA_DIR: directory });
  db = await openDatabase({ memory: true });
  for (const a of DEMO_AGENTS)
    await db.query(
      `INSERT INTO agents(id,name,email,password_hash,role) VALUES($1,$2,$3,'unused',$4)`,
      [a.id, a.name, a.email, a.role],
    );
  app = await buildApp(db, config);
  cookie = await login(DEMO_AGENTS[0].id);
});
after(async () => {
  await app?.close();
  await db?.close();
  await rm(directory, { recursive: true, force: true });
});
async function login(agentId: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/demo',
    headers: { origin: config.origin },
    payload: { agentId },
  });
  assert.equal(r.statusCode, 200);
  return r.cookies[0].name + '=' + r.cookies[0].value;
}
async function member(
  extra: {
    department?: string;
    roles?: string[];
    tags?: string[];
    linked?: boolean;
    blocked?: boolean;
  } = {},
) {
  const [u] = await db.query(
    `INSERT INTO users(line_user_id,name,cusa_sub,department,roles,interest_tags,blocked) VALUES($1,'สมาชิกทดสอบ',$2,$3,$4,$5,$6) RETURNING *`,
    [
      'U' + randomBytes(16).toString('hex'),
      extra.linked ? randomUUID() : null,
      extra.department ?? null,
      JSON.stringify(extra.roles ?? []),
      JSON.stringify(extra.tags ?? []),
      extra.blocked ?? false,
    ],
  );
  return u;
}
async function waiting(minutes: number) {
  const u = await member();
  const [c] = await db.query(
    `INSERT INTO conversations(user_id,status,handover_at) VALUES($1,'WAITING_FOR_AGENT',now()-($2*interval '1 minute')) RETURNING *`,
    [u.id, minutes],
  );
  return c;
}
const headers = () => ({ origin: config.origin, cookie });

test('audience filters combine OR within groups and AND between groups; blocked and missing claims are excluded', async () => {
  const tag = 'interest-' + randomUUID(),
    dept = 'department-' + randomUUID();
  const expected = await member({
    linked: true,
    department: dept,
    roles: ['alumni', 'volunteer'],
    tags: [tag],
  });
  await member({ linked: true, department: dept, roles: ['student'], tags: [tag] });
  await member({ linked: true, department: dept, roles: ['alumni'], tags: [tag], blocked: true });
  await member({ department: dept, roles: ['alumni'], tags: [tag] });
  await member({ linked: true, roles: ['alumni'], tags: [tag] });
  const audience = audienceBody.parse({
    segment: 'all',
    filters: { departments: [dept, 'another'], roles: ['alumni', 'staff'], tags: [tag] },
  });
  assert.deepEqual(
    (await audienceRecipients(db, audience)).map((u) => u.id),
    [expected.id],
  );
  assert.equal(await audienceCount(db, audience), 1);
  assert.equal(await audienceCount(db, { ...audience, segment: 'guests' }), 0);
  assert.equal(
    await audienceCount(
      db,
      audienceBody.parse({ segment: 'all', filters: { departments: ["' OR true --"] } }),
    ),
    0,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/broadcasts/preview',
    headers: headers(),
    payload: audience,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().count, 1);
  const options = await app.inject({
    url: '/api/broadcasts/audience-options',
    headers: { cookie },
  });
  assert.equal(options.statusCode, 200);
  assert.ok(options.json().tags.includes(tag));
});

test('broadcast preview counts beyond the member list limit; sending freezes the current audience into batches of at most 500', async () => {
  const tag = 'batch-' + randomUUID();
  await db.transaction(async (tx) => {
    for (let i = 0; i < 503; i++)
      await tx.query(
        `INSERT INTO users(line_user_id,name,interest_tags) VALUES($1,'สมาชิกทดสอบจำนวนมาก',$2)`,
        ['U' + randomUUID().replaceAll('-', ''), JSON.stringify([tag])],
      );
  });
  const audience = { segment: 'all', filters: { tags: [tag] } };
  const preview = await app.inject({
    method: 'POST',
    url: '/api/broadcasts/preview',
    headers: headers(),
    payload: audience,
  });
  assert.equal(preview.json().count, 503);
  await db.query(
    `UPDATE users SET blocked=true WHERE id=(SELECT id FROM users WHERE interest_tags ? $1 LIMIT 1)`,
    [tag],
  );
  const created = await app.inject({
    method: 'POST',
    url: '/api/broadcasts',
    headers: headers(),
    payload: { title: 'ทดสอบผู้รับจำนวนมาก', content: 'ส่งตามกลุ่มเป้าหมายที่เลือก', ...audience },
  });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().id;
  const sent = await app.inject({
    method: 'POST',
    url: `/api/broadcasts/${id}/send`,
    headers: headers(),
    payload: {},
  });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().recipients, 502);
  const batches = await db.query(
    `SELECT * FROM broadcast_batches WHERE broadcast_id=$1 ORDER BY jsonb_array_length(recipient_ids) DESC`,
    [id],
  );
  assert.deepEqual(
    batches.map((b) => b.recipient_ids.length),
    [500, 2],
  );
  assert.equal(new Set(batches.flatMap((b) => b.recipient_ids)).size, 502);
  await db.query(`UPDATE users SET interest_tags='[]' WHERE interest_tags ? $1`, [tag]);
  const requests: any[] = [];
  const worker = new Worker(db, { ...config, demo: false, lineToken: 'test' }, (async (
    _url,
    init,
  ) => {
    requests.push({
      body: JSON.parse(init!.body as string),
      key: (init!.headers as any)['X-Line-Retry-Key'],
    });
    if (requests.length === 1) throw new Error('timeout');
    return new Response('{}');
  }) as typeof fetch);
  await assert.rejects(worker.broadcast(batches[0].id));
  await worker.broadcast(batches[0].id);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].body.to.length, 500);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/broadcasts/${id}/send`,
        headers: headers(),
        payload: {},
      })
    ).statusCode,
    409,
  );
});

test('member changes and audience preview require admin; malformed filters and unknown members fail clearly', async () => {
  const u = await member(),
    reviewerCookie = await login(DEMO_AGENTS[1].id);
  for (const [method, url, payload] of [
    ['PATCH', `/api/members/${u.id}/interests`, { tags: ['กิจกรรม'] }],
    ['POST', `/api/members/${u.id}/rich-menu`, { menuId: null }],
    ['POST', `/api/broadcasts/preview`, { segment: 'all' }],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      payload,
      headers: { origin: config.origin, cookie: reviewerCookie },
    });
    assert.equal(response.statusCode, 403, response.body);
  }
  const saved = await app.inject({
    method: 'PATCH',
    url: `/api/members/${u.id}/interests`,
    headers: headers(),
    payload: { tags: ['กิจกรรม', 'กิจกรรม', 'ลงทะเบียน'] },
  });
  assert.deepEqual(saved.json().interest_tags, ['กิจกรรม', 'ลงทะเบียน']);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/broadcasts/preview',
        headers: headers(),
        payload: { segment: 'all', filters: { department: ['typo'] } },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/members/${randomUUID()}/unlink`,
        headers: headers(),
        payload: {},
      })
    ).statusCode,
    404,
  );
});

test('rich menu jobs skip stale revisions and unlink via DELETE without changing CUSA identity', async () => {
  const u = await member({ linked: true });
  const old = await db.transaction((tx) => queueRichMenu(tx, u.id, demoRichMenus[0].richMenuId));
  const latest = await db.transaction((tx) => queueRichMenu(tx, u.id, null));
  const requests: any[] = [];
  const worker = new Worker(db, { ...config, demo: false, lineToken: 'test' }, (async (
    url,
    init,
  ) => {
    requests.push({ url: String(url), method: init?.method });
    return new Response('{}');
  }) as typeof fetch);
  await worker.richMenu(u.id, demoRichMenus[0].richMenuId, old.revision);
  assert.equal(requests.length, 0);
  await worker.richMenu(u.id, null, latest.revision);
  await worker.richMenu(u.id, null, latest.revision);
  assert.deepEqual(requests, [
    { url: `https://api.line.me/v2/bot/user/${u.line_user_id}/richmenu`, method: 'DELETE' },
  ]);
  const [saved] = await db.query(`SELECT * FROM users WHERE id=$1`, [u.id]);
  assert.equal(saved.rich_menu_id, null);
  assert.equal(saved.rich_menu_status, 'ACCEPTED');
  assert.equal(saved.cusa_sub, u.cusa_sub);
  const unlink = await app.inject({
    method: 'POST',
    url: `/api/members/${u.id}/unlink`,
    headers: headers(),
    payload: {},
  });
  assert.equal(unlink.statusCode, 200, unlink.body);
  const [unlinked] = await db.query(`SELECT * FROM users WHERE id=$1`, [u.id]);
  assert.equal(unlinked.cusa_sub, null);
  assert.equal(unlinked.rich_menu_target, null);
  assert.equal(unlinked.rich_menu_status, 'PENDING');
});

test('supervisor alerts are queued once after five minutes and cancelled if the case has been claimed', async () => {
  const overdue = await waiting(6),
    fresh = await waiting(1),
    claimed = await waiting(7);
  const worker = new Worker(db, config);
  await Promise.all([worker.queueOverdueAlerts(), worker.queueOverdueAlerts()]);
  const jobs = await db.query(`SELECT * FROM jobs WHERE dedupe_key=$1`, [
    `supervisor:${overdue.id}:0`,
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(
    (await db.query(`SELECT supervisor_alert_status FROM conversations WHERE id=$1`, [fresh.id]))[0]
      .supervisor_alert_status,
    null,
  );
  await claimCase(db, config, DEMO_AGENTS[0] as Agent, claimed.id);
  let calls = 0;
  const liveWorker = new Worker(
    db,
    {
      ...config,
      demo: false,
      lineToken: 'test',
      supervisorAlertId: 'supervisor',
      agentAlertId: 'agent',
    },
    (async (_url, init) => {
      calls++;
      const body = JSON.parse(init!.body as string);
      assert.equal(body.to, 'supervisor');
      assert.equal((init!.headers as any)['X-Line-Retry-Key'], jobs[0].id);
      return new Response('{}');
    }) as typeof fetch,
  );
  await liveWorker.alert(claimed.id, randomUUID(), true);
  assert.equal(calls, 0);
  assert.equal(
    (
      await db.query(`SELECT supervisor_alert_status FROM conversations WHERE id=$1`, [claimed.id])
    )[0].supervisor_alert_status,
    'CANCELLED',
  );
  await liveWorker.alert(overdue.id, jobs[0].id, true);
  await liveWorker.alert(overdue.id, jobs[0].id, true);
  assert.equal(calls, 1);
  assert.ok(
    (
      await db.query(`SELECT supervisor_notified_at FROM conversations WHERE id=$1`, [overdue.id])
    )[0].supervisor_notified_at,
  );
  const unconfigured = await waiting(8);
  await new Worker(db, { ...config, demo: false }).queueOverdueAlerts();
  assert.equal(
    (
      await db.query(`SELECT supervisor_alert_status FROM conversations WHERE id=$1`, [
        unconfigured.id,
      ])
    )[0].supervisor_alert_status,
    null,
  );
});

test('operational analytics count Thai local hours and calculate response times from handover, excluding unclaimed cases', async () => {
  const isolated = await openDatabase({ memory: true });
  try {
    const [u] = await isolated.query(
      `INSERT INTO users(line_user_id,name) VALUES('Ustats','ทดสอบสถิติ') RETURNING id`,
    );
    const [c] = await isolated.query(
      `INSERT INTO conversations(user_id,status,handover_at,claimed_at) VALUES($1,'AGENT_IN_CHARGE',now()-interval '12 minutes',now()-interval '10 minutes') RETURNING id`,
      [u.id],
    );
    const yesterday = new Date(
      new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10) + 'T10:30:00+07:00',
    );
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await isolated.query(
      `INSERT INTO messages(conversation_id,sender_type,created_at) VALUES($1,'USER',$2)`,
      [c.id, yesterday],
    );
    const result = await operationalStats(isolated, config);
    assert.equal(result.claimed, 1);
    assert.equal(result.average_seconds, 120);
    assert.equal(result.p90_seconds, 120);
    assert.equal(result.within_target, 1);
    assert.equal(result.hourly.length, 24);
    assert.equal(result.hourly.find((h) => h.hour === 10)?.count, 1);
    const response = await app.inject({ url: '/api/stats', headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().operations.hourly.length, 24);
  } finally {
    await isolated.close();
  }
});

async function staff(name: string): Promise<Agent> {
  const [a] = await db.query(
    `INSERT INTO agents(name,email,password_hash,role) VALUES($1,$2,'unused','AGENT') RETURNING id,name,email,role`,
    [name, randomUUID() + '@test.local'],
  );
  return a as Agent;
}
async function staffCookie(a: Agent) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO auth_sessions(token_hash,agent_id,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
    [tokenHash(token), a.id],
  );
  return `cusa_session=${token}`;
}
test('ticket transfers retain the conversation, restrict responsibility, notify the destination and record acceptance', async () => {
  const owner = DEMO_AGENTS[2] as Agent,
    receiver = await staff('เจ้าหน้าที่ปลายทาง'),
    colleague = await staff('เจ้าหน้าที่ร่วมทีม');
  const team = await saveTeam(db, DEMO_AGENTS[0] as Agent, {
    name: 'หน่วยงานปลายทาง ' + randomUUID(),
    description: 'ช่วยแก้บัญชี',
    memberIds: [receiver.id, colleague.id],
    active: true,
  });
  const c = await waiting(8);
  await claimCase(db, config, owner, c.id);
  const originalMessage = await sendAgentMessage(
    db,
    config,
    owner,
    c.id,
    'ตรวจสอบเบื้องต้นแล้วจะส่งให้ทีมที่เกี่ยวข้องค่ะ',
    false,
    randomUUID(),
  );
  await new Worker(db, config).deliver(originalMessage.id);
  const input = {
    teamId: team.id!,
    agentId: receiver.id,
    reason: 'ผู้ใช้แจ้ง private@example.org ยังเข้าสู่ระบบไม่ได้ ต้องตรวจบัญชี CUSA ต่อ',
    expectedVersion: 0,
    requestId: randomUUID(),
  };
  const results = await Promise.all([
    transferCase(db, config, owner, c.id, input),
    transferCase(db, config, owner, c.id, input),
  ]);
  assert.equal(results[0].id, results[1].id);
  const [saved] = await db.query(`SELECT * FROM conversations WHERE id=$1`, [c.id]);
  assert.equal(saved.number, c.number);
  assert.equal(saved.status, 'WAITING_FOR_AGENT');
  assert.equal(saved.assigned_agent_id, receiver.id);
  assert.equal(saved.team_id, team.id);
  assert.equal(saved.claimed_at, null);
  const [raw] = await db.query(`SELECT * FROM case_transfers WHERE conversation_id=$1`, [c.id]);
  assert.ok(!raw.encrypted_reason.includes('private@example.org'));
  assert.ok(!raw.redacted_reason.includes('private@example.org'));
  assert.equal((await transferHistory(db, config, c.id))[0].reason, input.reason);
  await assert.rejects(
    sendAgentMessage(db, config, owner, c.id, 'ตอบต่อไม่ได้หลังโอน', false, randomUUID()),
  );
  await assert.rejects(claimCase(db, config, colleague, c.id));
  await assert.rejects(claimCase(db, config, owner, c.id));
  await assert.rejects(
    transferCase(db, config, DEMO_AGENTS[0] as Agent, c.id, { ...input, requestId: randomUUID() }),
    /เปลี่ยนหรือปิด/,
  );
  const notice = await db.query(`SELECT * FROM notifications WHERE transfer_id=$1`, [raw.id]);
  assert.equal(notice.length, 1);
  assert.equal(notice[0].agent_id, receiver.id);
  const receiverCookie = await staffCookie(receiver);
  const notifications = await app.inject({
    url: '/api/notifications',
    headers: { cookie: receiverCookie },
  });
  assert.equal(notifications.json().unread, 1);
  const foreignRead = await app.inject({
    method: 'POST',
    url: `/api/notifications/${notice[0].id}/read`,
    headers: headers(),
    payload: {},
  });
  assert.equal(foreignRead.statusCode, 404);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/notifications/${notice[0].id}/read`,
        headers: { origin: config.origin, cookie: receiverCookie },
        payload: {},
      })
    ).statusCode,
    200,
  );
  await claimCase(db, config, receiver, c.id);
  await assert.rejects(
    sendAgentMessage(db, config, owner, c.id, 'ผู้รับเดิมตอบแทรกไม่ได้', false, randomUUID()),
  );
  const response = await sendAgentMessage(
    db,
    config,
    receiver,
    c.id,
    'ตรวจบัญชีเรียบร้อยแล้ว สามารถลองเข้าสู่ระบบอีกครั้งได้ค่ะ',
    false,
    randomUUID(),
  );
  const timeline = await getMessages(db, config, c.id);
  assert.ok(timeline.some((m) => m.id === originalMessage.id));
  assert.ok(timeline.some((m) => m.id === response.id));
  assert.equal((await transferHistory(db, config, c.id))[0].accepted_by, receiver.id);
  const transcript = await app.inject({
    url: `/api/conversations/${c.id}/transcript`,
    headers: { cookie: receiverCookie },
  });
  assert.equal(transcript.statusCode, 200, transcript.body);
  assert.equal(transcript.json().transfers[0].reason, input.reason);
  assert.equal(transcript.json().messages.filter((m: any) => m.sender_type === 'AGENT').length, 2);
  const tickets = await app.inject({
    url: '/api/tickets?mine=true',
    headers: { cookie: receiverCookie },
  });
  assert.ok(tickets.json().some((t: any) => t.id === c.id));
  await assert.rejects(
    saveTeam(
      db,
      DEMO_AGENTS[0] as Agent,
      { name: 'ห้ามนำเจ้าของเคสออก', description: '', memberIds: [colleague.id], active: true },
      team.id,
    ),
    /ยังมีเคสเปิด/,
  );
  const second = await transferCase(db, config, receiver, c.id, {
    ...input,
    agentId: null,
    expectedVersion: 1,
    requestId: randomUUID(),
  });
  assert.equal(
    (await db.query(`SELECT * FROM notifications WHERE transfer_id=$1`, [second.id])).length,
    2,
  );
  const claims = await Promise.allSettled([
    claimCase(db, config, receiver, c.id),
    claimCase(db, config, colleague, c.id),
  ]);
  assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
});

test('transfer API validates roles, destination membership and optimistic version; stale alerts cannot follow a transferred case', async () => {
  const owner = DEMO_AGENTS[2] as Agent,
    receiver = await staff('ผู้ดูแลระบบปลายทาง');
  const team = await saveTeam(db, DEMO_AGENTS[0] as Agent, {
    name: 'ทีมตรวจสอบ ' + randomUUID(),
    description: '',
    memberIds: [receiver.id],
    active: true,
  });
  const c = await waiting(8),
    worker = new Worker(db, config);
  await worker.queueOverdueAlerts();
  const [oldJob] = await db.query(`SELECT * FROM jobs WHERE dedupe_key=$1`, [
    `supervisor:${c.id}:0`,
  ]);
  await claimCase(db, config, owner, c.id);
  const input = {
    teamId: team.id,
    agentId: receiver.id,
    reason: 'ส่งตรวจสอบปัญหาที่ทีมเดิมไม่สามารถแก้ได้',
    expectedVersion: 0,
    requestId: randomUUID(),
  };
  const reviewerCookie = await login(DEMO_AGENTS[1].id),
    ownerCookie = await login(owner.id);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/conversations/${c.id}/transfer`,
        headers: { origin: config.origin, cookie: reviewerCookie },
        payload: input,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/conversations/${c.id}/transfer`,
        headers: { origin: config.origin, cookie: ownerCookie },
        payload: { ...input, agentId: owner.id },
      })
    ).statusCode,
    400,
  );
  const transferred = await app.inject({
    method: 'POST',
    url: `/api/conversations/${c.id}/transfer`,
    headers: { origin: config.origin, cookie: ownerCookie },
    payload: input,
  });
  assert.equal(transferred.statusCode, 200, transferred.body);
  await worker.queueOverdueAlerts();
  assert.equal(
    (await db.query(`SELECT supervisor_alert_status FROM conversations WHERE id=$1`, [c.id]))[0]
      .supervisor_alert_status,
    null,
  );
  await db.query(`UPDATE conversations SET handover_at=now()-interval '6 minutes' WHERE id=$1`, [
    c.id,
  ]);
  await worker.queueOverdueAlerts();
  await worker.alert(c.id, oldJob.id, true, 0);
  assert.equal(
    (await db.query(`SELECT supervisor_alert_status FROM conversations WHERE id=$1`, [c.id]))[0]
      .supervisor_alert_status,
    'PENDING',
  );
  const [newJob] = await db.query(`SELECT * FROM jobs WHERE dedupe_key=$1`, [
    `supervisor:${c.id}:1`,
  ]);
  assert.ok(newJob);
  await worker.alert(c.id, newJob.id, true, 1);
  assert.equal(
    (await db.query(`SELECT supervisor_alert_status FROM conversations WHERE id=$1`, [c.id]))[0]
      .supervisor_alert_status,
    'SIMULATED',
  );
  await claimCase(db, config, receiver, c.id);
  await closeCase(db, config, receiver, c.id, 'RESOLVED_HUMAN', 'แก้ไขเรียบร้อยและแจ้งสมาชิกแล้ว');
  await assert.rejects(
    transferCase(db, config, receiver, c.id, {
      ...input,
      expectedVersion: 1,
      requestId: randomUUID(),
    }),
    /เปลี่ยนหรือปิด/,
  );
});
