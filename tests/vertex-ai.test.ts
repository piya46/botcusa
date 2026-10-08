import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../server/config.js';
import { generateText, embed } from '../server/providers.js';
import { readVertexCredentials, embeddingIdentity } from '../server/vertex-auth.js';
import { vertexSettings } from '../shared/vertex.js';
import { defaultAiBehavior, type AiBehavior } from '../shared/ai.js';
import { openDatabase } from './database.js';
import { Worker } from '../server/worker.js';
import { buildApp } from '../server/app.js';
import { seed, DEMO_AGENTS as SEED_AGENTS } from '../server/seed.js';
import type { Agent } from '../shared/types.js';
import { encrypt, decrypt } from '../server/security.js';
import {
  createExample,
  reviewExample,
  revokeMessageData,
  createDataset,
  retireExample,
} from '../server/training.js';
import { findResponseExamples } from '../server/response-examples.js';
import { claimCase } from '../server/conversations.js';
const DEMO_AGENTS = SEED_AGENTS as Agent[];

async function teachingExample(
  f: Awaited<ReturnType<typeof fixture>>,
  answer = 'อธิบายการสมัครทีละขั้น ถามว่าติดที่หน้าหรือขั้นตอนไหน',
) {
  const c = await f.waiting();
  const [source] = await f.db.query(
    "INSERT INTO messages(conversation_id,sender_type,encrypted_text,redacted_text) VALUES($1,'USER',$2,'สมัครสมาชิกมีปัญหา') RETURNING id",
    [c.id, encrypt('สมัครสมาชิกมีปัญหา', f.config.encryptionKey)],
  );
  await f.db.query(
    "INSERT INTO messages(conversation_id,sender_type,agent_id,encrypted_text,redacted_text,delivery_status) VALUES($1,'AGENT',$2,$3,$4,'ACCEPTED')",
    [c.id, DEMO_AGENTS[2].id, encrypt(answer, f.config.encryptionKey), answer],
  );
  await f.db.query(
    "UPDATE conversations SET status='CLOSED',closed_at=now(),resolution='RESOLVED_HUMAN' WHERE id=$1",
    [c.id],
  );
  const example = await createExample(f.db, f.config, DEMO_AGENTS[2], c.id);
  return { example, source };
}

test('approved examples enter live Gemini context, follow configured style, and remain separate from factual citations', async () => {
  const f = await fixture();
  try {
    const { example, source } = await teachingExample(f);
    const draft = await teachingExample(f, 'DRAFT_NOT_FOR_PROVIDER');
    const rejected = await teachingExample(f, 'REJECTED_NOT_FOR_PROVIDER');
    await reviewExample(f.db, DEMO_AGENTS[1], rejected.example.id, false);
    assert.equal((await findResponseExamples(f.db, 'สมัครสมาชิกมีปัญหา')).length, 0);
    await reviewExample(f.db, DEMO_AGENTS[1], example.id, true);
    await f.behavior({ tone: 'formal', format: 'steps' });
    f.decision({
      action: 'clarify',
      kind: 'general',
      text: 'กรุณาระบุขั้นตอนที่พบปัญหาในการสมัครค่ะ',
      reference_ids: [],
      intake: { summary: 'ผู้ใช้แจ้งปัญหาการสมัคร', missing_fields: ['step', 'error'] },
    });
    const result = await f.say(await f.waiting(), 'สมัครสมาชิกมีปัญหา');
    const call = f.calls.at(-1)!;
    const payload = JSON.parse(call.body.contents[0].parts[0].text);
    assert.equal(payload.response_examples.length, 1);
    assert.equal(payload.response_examples[0].id, example.id);
    assert.equal(
      payload.response_examples[0].context,
      undefined,
      'never send full training conversations',
    );
    assert.ok(!JSON.stringify(payload).includes('NOT_FOR_PROVIDER'));
    assert.match(
      call.body.systemInstruction.parts[0].text,
      /บุคลิกที่ตั้งไว้มีลำดับเหนือสำนวนตัวอย่าง/,
    );
    assert.match(call.body.systemInstruction.parts[0].text, /ไม่คัดลอกสำนวนต้นฉบับทั้งก้อน/);
    assert.match(call.body.systemInstruction.parts[0].text, /เป็นทางการ/);
    assert.match(result.reply.text, /กรุณาระบุ/);
    assert.equal(result.reply.metadata.response_examples[0].id, example.id);
    assert.deepEqual(result.reply.metadata.knowledge_used, []);
    // An example ID can never authorize a factual answer.
    f.decision({
      action: 'answer',
      kind: 'knowledge',
      text: 'EXAMPLE_FACT_MUST_NOT_ESCAPE',
      reference_ids: [example.id],
    });
    const invalid = await f.say(await f.waiting(), 'สมัครสมาชิกมีปัญหา');
    assert.ok(!invalid.reply.text.includes('EXAMPLE_FACT'));
    await f.behavior({ useApprovedExamples: false });
    await f.say(await f.waiting(), 'สมัครสมาชิกมีปัญหา');
    assert.deepEqual(
      JSON.parse(f.calls.at(-1)!.body.contents[0].parts[0].text).response_examples,
      [],
    );
    await f.behavior({ useApprovedExamples: true });
    await f.db.query("UPDATE settings SET value=$1 WHERE key='training_policy'", [
      JSON.stringify({ enabled: false, notice_version: 'test' }),
    ]);
    assert.deepEqual(await findResponseExamples(f.db, 'สมัครสมาชิกมีปัญหา'), []);
    await f.db.query("UPDATE settings SET value=$1 WHERE key='training_policy'", [
      JSON.stringify({ enabled: true, notice_version: 'test' }),
    ]);
    await f.db.transaction((tx) => revokeMessageData(tx, source.id));
    assert.deepEqual(await findResponseExamples(f.db, 'สมัครสมาชิกมีปัญหา'), []);
    assert.equal(
      (await f.db.query('SELECT status FROM training_examples WHERE id=$1', [example.id]))[0]
        .status,
      'REVOKED',
    );
    assert.equal(
      (await f.db.query('SELECT status FROM training_examples WHERE id=$1', [draft.example.id]))[0]
        .status,
      'DRAFT',
    );
  } finally {
    await f.close();
  }
});

test('example withdrawal while Gemini runs discards the answer; a retry uses fresh examples', async () => {
  const f = await fixture();
  try {
    const { example, source } = await teachingExample(f);
    await reviewExample(f.db, DEMO_AGENTS[1], example.id, true);
    const c = await f.waiting();
    f.beforeResponse(async () => {
      await f.db.transaction((tx) => revokeMessageData(tx, source.id));
    });
    await assert.rejects(f.say(c, 'สมัครสมาชิกมีปัญหา'), /ตัวอย่างถูกถอน/);
    assert.equal(
      (
        await f.db.query("SELECT id FROM messages WHERE conversation_id=$1 AND sender_type='BOT'", [
          c.id,
        ])
      ).length,
      0,
    );
    f.beforeResponse(undefined);
    const [sourceMessage] = await f.db.query(
      "SELECT id FROM messages WHERE conversation_id=$1 AND sender_type='USER'",
      [c.id],
    );
    await f.worker.botReply(sourceMessage.id);
    assert.equal(
      (
        await f.db.query("SELECT id FROM messages WHERE conversation_id=$1 AND sender_type='BOT'", [
          c.id,
        ])
      ).length,
      1,
    );
    assert.deepEqual(
      JSON.parse(f.calls.at(-1)!.body.contents[0].parts[0].text).response_examples,
      [],
    );
  } finally {
    await f.close();
  }
});

test('retiring an approved example stops live use and dataset export, with reviewer permissions', async () => {
  const f = await fixture();
  try {
    const { example } = await teachingExample(f);
    await reviewExample(f.db, DEMO_AGENTS[1], example.id, true);
    const dataset = await createDataset(f.db, DEMO_AGENTS[1], 'synthetic');
    await assert.rejects(retireExample(f.db, DEMO_AGENTS[2], example.id), /ผู้ตรวจทาน/);
    await retireExample(f.db, DEMO_AGENTS[1], example.id);
    assert.deepEqual(await findResponseExamples(f.db, 'สมัครสมาชิกมีปัญหา'), []);
    const [item] = await f.db.query(
      'SELECT * FROM dataset_items WHERE dataset_id=$1 AND example_id=$2',
      [dataset.id, example.id],
    );
    assert.equal(item.snapshot, null);
    assert.ok(item.revoked_at);
  } finally {
    await f.close();
  }
});

test('staff intake keeps context, summarizes for the team, and acknowledges the chosen public name once', async () => {
  const f = await fixture();
  try {
    const c = await f.waiting();
    f.decision({
      action: 'clarify',
      kind: 'general',
      text: 'เกิดปัญหาที่ขั้นตอนไหน และมีข้อความแจ้งอะไรบ้างคะ',
      reference_ids: [],
      intake: {
        summary: 'ผู้ใช้ต้องการติดต่อเจ้าหน้าที่',
        missing_fields: ['situation', 'step', 'error'],
      },
    });
    const first = await f.say(c, 'ขอคุยกับเจ้าหน้าที่ครับ');
    assert.equal(first.reply.metadata.handover, false);
    assert.equal(first.reply.metadata.pending_handover_reason, 'USER_REQUEST');
    f.decision({
      action: 'clarify',
      kind: 'general',
      text: 'เริ่มพบปัญหาเมื่อไหร่ และลองทำอะไรแล้วบ้างคะ',
      reference_ids: [],
      intake: { summary: 'กดสมัครสมาชิกแล้วพบ Error 500', missing_fields: ['timing', 'attempts'] },
    });
    const second = await f.say(c, 'กดสมัครสมาชิกแล้วขึ้น Error 500 ครับ');
    assert.equal(second.reply.metadata.response_kind, 'clarify');
    assert.notEqual(second.reply.text, first.reply.text);
    const secondPayload = JSON.parse(f.calls.at(-1)!.body.contents[0].parts[0].text);
    assert.equal(secondPayload.handover_required, 'USER_REQUEST');
    assert.ok(
      secondPayload.history.some((m: any) => m.redacted_text.includes('ขอคุยกับเจ้าหน้าที่')),
    );
    f.decision({
      action: 'handover',
      kind: 'general',
      text: '',
      reference_ids: [],
      intake: {
        summary: 'สมัครสมาชิกพบ Error 500 เมื่อเช้านี้ ลองรีเฟรชแล้วไม่หาย',
        missing_fields: [],
      },
    });
    const third = await f.say(c, 'เมื่อเช้าครับ ลองรีเฟรชแล้วไม่หาย');
    assert.equal(third.reply.metadata.handover, true);
    assert.equal(third.reply.metadata.handover_reason, 'USER_REQUEST');
    assert.match(third.reply.text, /เมื่อเจ้าหน้าที่รับดูแล/);
    const [brief] = await f.db.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND internal AND sender_type='SYSTEM'",
      [c.id],
    );
    assert.match(decrypt(brief.encrypted_text, f.config.encryptionKey), /Error 500.*รีเฟรช/);
    await f.db.query("UPDATE agents SET public_display_name='พี่ต้น ทีมบริการ' WHERE id=$1", [
      DEMO_AGENTS[0].id,
    ]);
    await claimCase(f.db, f.config, DEMO_AGENTS[0], c.id);
    await assert.rejects(claimCase(f.db, f.config, DEMO_AGENTS[0], c.id), /ผู้รับงานแล้ว/);
    const claims = await f.db.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND metadata->>'system_event'='CASE_CLAIMED'",
      [c.id],
    );
    assert.equal(claims.length, 1);
    assert.match(
      decrypt(claims[0].encrypted_text, f.config.encryptionKey),
      /พี่ต้น ทีมบริการ รับเรื่องแล้ว/,
    );
    assert.equal((await f.say(c, 'ขอบคุณ')).reply, undefined);
    await f.db.transaction((tx) => revokeMessageData(tx, first.m.id));
    const [withdrawnBrief] = await f.db.query('SELECT * FROM messages WHERE id=$1', [brief.id]);
    assert.equal(
      withdrawnBrief.encrypted_text,
      null,
      'intake summary is withdrawn with its source',
    );
    assert.ok(withdrawnBrief.withdrawn_at);
  } finally {
    await f.close();
  }
});

test('complete reports, urgent requests and refusal do not create unnecessary intake rounds', async () => {
  const f = await fixture();
  try {
    f.decision({
      action: 'handover',
      kind: 'general',
      text: '',
      reference_ids: [],
      intake: {
        summary:
          'กดสมัครสมาชิกวันนี้แล้วขึ้น Error 500 ลองใหม่สองครั้งไม่สำเร็จ ต้องการเจ้าหน้าที่ตรวจสอบ',
        missing_fields: [],
      },
    });
    assert.equal(
      (
        await f.say(
          await f.waiting(),
          'ขอเจ้าหน้าที่ตรวจสอบ กดสมัครวันนี้ขึ้น Error 500 ลองใหม่สองครั้งแล้ว',
        )
      ).reply.metadata.handover,
      true,
    );
    assert.equal(
      (await f.say(await f.waiting(), 'ส่งต่อเลย ไม่ต้องถามครับ')).reply.metadata.handover,
      true,
    );
    f.decision({ action: 'handover', kind: 'general', text: '', reference_ids: [] });
    const c = await f.waiting();
    assert.equal(
      (await f.say(c, 'มีปัญหาครับ')).reply.metadata.response_kind,
      'clarify',
      'initial missing detail must be collected even if model skips it',
    );
    assert.equal((await f.say(c, 'ไม่ทราบครับ')).reply.metadata.handover, true);
  } finally {
    await f.close();
  }
});

test('staff can change only their public display name without changing SSO name or roles', async () => {
  const f = await fixture();
  const app = await buildApp(f.db, f.config);
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/demo',
      headers: { origin: f.config.origin },
      payload: { agentId: DEMO_AGENTS[2].id },
    });
    const headers = {
      origin: f.config.origin,
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    };
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers,
      payload: { publicDisplayName: '  พี่แนน  ' },
    });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(update.json().publicDisplayName, 'พี่แนน');
    const [staff] = await f.db.query('SELECT * FROM agents WHERE id=$1', [DEMO_AGENTS[2].id]);
    assert.equal(staff.name, DEMO_AGENTS[2].name);
    assert.equal(staff.role, 'AGENT');
    for (const payload of [
      { publicDisplayName: 'another', agentId: DEMO_AGENTS[0].id },
      { publicDisplayName: 'another', role: 'ADMIN' },
      { publicDisplayName: 'bad\nname' },
      { publicDisplayName: 'x'.repeat(81) },
    ])
      assert.equal(
        (await app.inject({ method: 'PATCH', url: '/api/account/profile', headers, payload }))
          .statusCode,
        400,
      );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/account/profile',
          headers,
          payload: { publicDisplayName: '' },
        })
      ).json().publicDisplayName,
      null,
    );
  } finally {
    await app.close();
    await f.close();
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cusa-vertex-'));
  const config = getConfig({
    APP_MODE: 'demo',
    DATA_DIR: root,
    GOOGLE_CLOUD_PROJECT: 'synthetic-project',
    VERTEX_AI_MODEL: 'synthetic-model',
    GOOGLE_CLOUD_LOCATION: 'global',
  });
  const live = { ...config, demo: false };
  const db = await openDatabase({ memory: true });
  await seed(db, config);
  let decision: unknown = {
    action: 'clarify',
    kind: 'general',
    text: 'ติดปัญหาขั้นตอนไหนคะ',
    reference_ids: [],
  };
  let failureStatus = 0;
  let beforeResponse: (() => Promise<void>) | undefined;
  const calls: { url: string; body: any; headers: any }[] = [];
  const fetcher = (async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    if (failureStatus)
      return Response.json({ error: 'synthetic private provider body' }, { status: failureStatus });
    await beforeResponse?.();
    return Response.json({
      candidates: [
        { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(decision) }] } },
      ],
    });
  }) as typeof fetch;
  const worker = new Worker(db, live, fetcher, async () => 'synthetic-access');
  const waiting = async () => {
    const [u] = await db.query(
      "INSERT INTO users(line_user_id,name) VALUES($1,'Contact') RETURNING id",
      ['U' + randomUUID().replaceAll('-', '')],
    );
    const [c] = await db.query('INSERT INTO conversations(user_id) VALUES($1) RETURNING *', [u.id]);
    return c;
  };
  const say = async (c: any, text: string) => {
    const [m] = await db.query(
      "INSERT INTO messages(conversation_id,sender_type,encrypted_text,redacted_text) VALUES($1,'USER',$2,$3) RETURNING id",
      [c.id, encrypt(text, config.encryptionKey), text],
    );
    await worker.botReply(m.id);
    const [reply] = await db.query(
      "SELECT * FROM messages WHERE conversation_id=$1 AND sender_type='BOT' AND metadata->>'source_message_id'=$2",
      [c.id, m.id],
    );
    if (reply) reply.text = decrypt(reply.encrypted_text, config.encryptionKey);
    return { m, reply };
  };
  const behavior = async (value: Partial<AiBehavior>) => {
    await db.query(
      "INSERT INTO settings(key,value) VALUES('ai_behavior',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify({ ...defaultAiBehavior, ...value })],
    );
  };
  return {
    root,
    config,
    live,
    db,
    worker,
    waiting,
    say,
    calls,
    behavior,
    decision: (value: unknown) => {
      decision = value;
    },
    failProvider: (status: number) => {
      failureStatus = status;
    },
    beforeResponse: (callback?: () => Promise<void>) => {
      beforeResponse = callback;
    },
    close: async () => {
      await worker.stop();
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Vertex uses project/location OAuth, structured schema and documented embedding predict shape', async () => {
  const f = await fixture();
  try {
    const calls: any[] = [];
    const response = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers,
      });
      return String(url).endsWith(':predict')
        ? Response.json({
            predictions: [{ embeddings: { values: Array.from({ length: 768 }, () => 0.1) } }],
          })
        : Response.json({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [
                    { thought: true, text: 'private reasoning' },
                    { text: '{"answer":"ok"}' },
                  ],
                },
              },
            ],
          });
    }) as typeof fetch;
    const token = async () => 'synthetic-access';
    const out = await generateText(
      f.live,
      'question',
      'policy',
      response,
      {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      token,
    );
    assert.equal(out, '{"answer":"ok"}');
    assert.equal(
      calls[0].url,
      'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models/synthetic-model:generateContent',
    );
    assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-access');
    assert.equal(calls[0].headers['x-goog-api-key'], undefined);
    assert.equal(calls[0].body.generationConfig.responseSchema.type, 'OBJECT');
    const config = { ...f.live, embeddingModel: 'gemini-embedding-001' };
    assert.equal(
      (await embed(config, 'document', response, 'RETRIEVAL_DOCUMENT', token))?.length,
      768,
    );
    assert.ok(calls[1].url.startsWith('https://us-central1-aiplatform.googleapis.com/'));
    assert.deepEqual(calls[1].body, {
      instances: [{ content: 'document', task_type: 'RETRIEVAL_DOCUMENT' }],
      parameters: { outputDimensionality: 768, autoTruncate: true },
    });
    await embed(config, 'query', response, 'RETRIEVAL_QUERY', token);
    assert.equal(calls[2].body.instances[0].task_type, 'RETRIEVAL_QUERY');
    assert.notEqual(
      embeddingIdentity(config),
      config.embeddingModel,
      'old embeddings cannot mix with new task types/provider',
    );
    await assert.rejects(
      embed(
        config,
        'bad',
        async () => Response.json({ predictions: [{ embeddings: { values: [1, 2] } }] }),
        'RETRIEVAL_QUERY',
        token,
      ),
      /embedding/,
    );
    await assert.rejects(
      generateText(
        f.live,
        'q',
        's',
        async () =>
          Response.json({
            candidates: [
              { finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'incomplete' }] } },
            ],
          }),
        undefined,
        token,
      ),
      /สมบูรณ์/,
    );
    await assert.rejects(
      generateText(
        f.live,
        'q',
        's',
        async () => Response.json({ error: 'do-not-expose-provider-secret' }, { status: 403 }),
        undefined,
        token,
      ),
      (error) => String(error).includes('403') && !String(error).includes('do-not-expose'),
    );
    await assert.rejects(generateText(f.config, 'q', 's', response, undefined, token), /เชื่อมต่อ/);
  } finally {
    await f.close();
  }
});

test('Vertex config and service-account input reject unsafe paths and foreign credential mechanisms', async () => {
  const f = await fixture();
  try {
    assert.throws(() => vertexSettings({ GOOGLE_CLOUD_LOCATION: 'localhost/../../' }));
    assert.throws(() => vertexSettings({ VERTEX_AI_MODEL: 'models/unexpected' }));
    assert.throws(() => vertexSettings({ VERTEX_AI_EMBEDDING_MODEL: 'gemini-embedding-2' }));
    const credentials = {
      type: 'service_account',
      client_email: 'test@synthetic-project.iam.gserviceaccount.com',
      private_key: 'synthetic-test-key'.repeat(10),
      token_uri: 'https://untrusted.example/token',
    };
    const secret = join(f.root, 'credential.json');
    await writeFile(secret, JSON.stringify(credentials));
    assert.equal((readVertexCredentials(secret, f.root) as any).token_uri, undefined);
    await mkdir(join(f.root, 'public'));
    await writeFile(join(f.root, 'public', 'key.json'), JSON.stringify(credentials));
    assert.throws(() => readVertexCredentials('public/key.json', f.root), /นอก public/);
    await symlink(secret, join(f.root, 'public', 'alias.json'));
    assert.throws(() => readVertexCredentials('public/alias.json', f.root), /นอก public/);
    await writeFile(
      secret,
      JSON.stringify({
        type: 'external_account',
        credential_source: { executable: { command: 'unsafe' } },
      }),
    );
    assert.throws(() => readVertexCredentials(secret, f.root), /ชนิดไฟล์/);
  } finally {
    await f.close();
  }
});

test('basic greetings stay with the bot; unknown requests clarify only up to the configured limit', async () => {
  const f = await fixture();
  try {
    const c = await f.waiting();
    const hello = await f.say(c, 'สวัสดีครับ');
    assert.equal(hello.reply.metadata.response_kind, 'general');
    assert.match(hello.reply.text, /ผู้ช่วย AI/);
    assert.equal(f.calls.length, 0, 'greeting needs no provider call');
    const first = await f.say(c, 'มีปัญหานิดหน่อย');
    assert.equal(first.reply.metadata.response_kind, 'clarify');
    await f.worker.botReply(first.m.id);
    assert.equal(f.calls.length, 1, 'redelivery does not consume another clarification');
    const second = await f.say(c, 'ยังไม่แน่ใจเลย');
    assert.equal(second.reply.metadata.response_kind, 'clarify');
    const third = await f.say(c, 'ยังไม่ได้อีก');
    assert.equal(third.reply.metadata.handover, true);
    assert.equal(f.calls.length, 2);
    assert.equal(
      (await f.db.query('SELECT status FROM conversations WHERE id=$1', [c.id]))[0].status,
      'WAITING_FOR_AGENT',
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM jobs WHERE kind='ALERT' AND payload->>'conversationId'=$1",
          [c.id],
        )
      ).length,
      1,
    );
    const later = await f.say(c, 'ขอรายละเอียดเพิ่ม');
    assert.equal(later.reply, undefined, 'bot stops after handover');
  } finally {
    await f.close();
  }
});

test('AI settings are admin-only, take effect on next answer, and do not expose Cloud credentials', async () => {
  const f = await fixture();
  const app = await buildApp(f.db, f.config);
  try {
    const login = async (id: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/demo',
        headers: { origin: f.config.origin },
        payload: { agentId: id },
      });
      return r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    };
    const admin = await login(DEMO_AGENTS[0].id),
      agent = await login(DEMO_AGENTS[2].id);
    const settings = await app.inject({ url: '/api/settings', headers: { cookie: admin } });
    const data = settings.json();
    assert.equal(data.integrations.vertex, false);
    assert.ok(!settings.body.includes('private_key'));
    assert.deepEqual(data.settings.ai_behavior, defaultAiBehavior);
    const body = {
      system_prompt: data.settings.system_prompt,
      training_policy: data.settings.training_policy,
      ai_behavior: {
        ...defaultAiBehavior,
        tone: 'formal',
        language: 'en',
        length: 'detailed',
        format: 'steps',
        clarificationLimit: 1,
      },
    };
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers: { origin: f.config.origin, cookie: agent },
          payload: body,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers: { origin: f.config.origin, cookie: admin },
          payload: { ...body, ai_behavior: { ...body.ai_behavior, clarificationLimit: 10 } },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          headers: { origin: f.config.origin, cookie: admin },
          payload: body,
        })
      ).statusCode,
      200,
    );
    const c = await f.waiting();
    const hi = await f.say(c, 'สวัสดี');
    assert.match(hi.reply.text, /Hello/);
    await f.say(c, 'Could you help me with a problem?');
    const prompt = f.calls[0].body.systemInstruction.parts[0].text;
    for (const fragment of ['เป็นทางการ', 'ตอบภาษาอังกฤษ', 'ละเอียด', 'เรียงขั้นตอน'])
      assert.ok(prompt.includes(fragment));
    const next = await f.say(c, 'It still fails');
    assert.equal(next.reply.metadata.handover, true, 'new clarification limit applies');
  } finally {
    await app.close();
    await f.close();
  }
});

test('strict mode, personal lookups, uncertain or fabricated citations and staff requests hand over safely', async () => {
  const f = await fixture();
  try {
    await f.behavior({ mode: 'knowledge_only' });
    let c = await f.waiting();
    assert.equal(
      (await f.say(c, 'คำถามที่ไม่มีข้อมูล zxzz')).reply.metadata.response_kind,
      'clarify',
    );
    await f.behavior({ mode: 'conversational' });
    c = await f.waiting();
    assert.equal(
      (await f.say(c, 'ตรวจสอบสถานะสมาชิกของฉัน')).reply.metadata.pending_handover_reason,
      'VERIFICATION_REQUIRED',
    );
    c = await f.waiting();
    assert.equal(
      (await f.say(c, 'ขอคุยกับคน')).reply.metadata.pending_handover_reason,
      'USER_REQUEST',
    );
    assert.equal(
      (await f.say(c, 'ขอคุยกับคน')).reply.metadata.handover_reason,
      'USER_REQUEST',
      'repeat request bypasses intake',
    );
    f.decision({
      action: 'answer',
      kind: 'knowledge',
      text: 'รายละเอียดที่โมเดลแต่งขึ้น',
      reference_ids: [randomUUID()],
    });
    c = await f.waiting();
    const result = await f.say(c, 'กิจกรรม xyz จัดเมื่อไหร่');
    assert.equal(result.reply.metadata.pending_handover_reason, 'MODEL_UNCERTAIN');
    assert.ok(!result.reply.text.includes('แต่งขึ้น'));
    await f.db.query(
      "UPDATE conversations SET status='AGENT_IN_CHARGE',assigned_agent_id=$2 WHERE id=$1",
      [c.id, DEMO_AGENTS[0].id],
    );
    assert.equal((await f.say(c, 'เพิ่มรายละเอียด')).reply, undefined);
  } finally {
    await f.close();
  }
});

test('concurrent messages share the clarification budget and queue only one handover', async () => {
  const f = await fixture();
  try {
    await f.behavior({ clarificationLimit: 1 });
    const c = await f.waiting();
    await Promise.all([
      f.say(c, 'คำถามแรก xyz'),
      f.say(c, 'คำถามถัดมา zyx'),
      f.say(c, 'คำถามที่สาม yyx'),
    ]);
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM messages WHERE conversation_id=$1 AND metadata->>'response_kind'='clarify'",
          [c.id],
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT id FROM jobs WHERE kind='ALERT' AND payload->>'conversationId'=$1",
          [c.id],
        )
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('basic conversation fallback follows the language setting without Vertex credentials', async () => {
  const f = await fixture();
  try {
    f.worker.config.vertexProject = '';
    const c = await f.waiting();
    const english = await f.say(c, 'I need help with something');
    assert.match(english.reply.text, /could you describe/i);
    assert.equal(f.calls.length, 0);
    await f.behavior({ language: 'th' });
    const thai = await f.say(await f.waiting(), 'Still unclear');
    assert.match(thai.reply.text, /ขอทราบ/);
  } finally {
    await f.close();
  }
});

test('published short questions reach Vertex with knowledge and selected personality; drafts stay excluded', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE knowledge SET status='ARCHIVED'");
    const [k] = await f.db.query(
      "INSERT INTO knowledge(title,content,published_title,published_content,category,status,created_by,updated_by) VALUES('สมัครสมาชิก','สมัครผ่านเว็บไซต์สมาคม เลือกเมนูสมัครสมาชิก','สมัครสมาชิก','สมัครผ่านเว็บไซต์สมาคม เลือกเมนูสมัครสมาชิก','ทั่วไป','PUBLISHED',$1,$1) RETURNING id",
      [DEMO_AGENTS[0].id],
    );
    await f.db.query(
      "INSERT INTO knowledge(title,content,category,status,created_by,updated_by) VALUES('สมัครสมาชิก','เนื้อหาลับฉบับร่างห้ามส่งให้โมเดล','ทั่วไป','DRAFT',$1,$1)",
      [DEMO_AGENTS[0].id],
    );
    await f.behavior({ mode: 'knowledge_only', tone: 'formal', format: 'steps' });
    const retrieved = await f.worker.searchKnowledge('สมัครสมาชิก');
    assert.ok(
      retrieved.some((r) => r.id === k.id),
      'short Thai question must find published title without keywords',
    );
    f.decision({
      action: 'answer',
      kind: 'knowledge',
      text: '1. เข้าเว็บไซต์สมาคม\n2. เลือกเมนูสมัครสมาชิก',
      reference_ids: [k.id],
    });
    const result = await f.say(await f.waiting(), 'สมัครสมาชิก');
    assert.equal(result.reply.metadata.handover, false);
    const call = f.calls.find((c) => c.url.endsWith(':generateContent'))!;
    assert.ok(call);
    const payload = JSON.parse(call.body.contents[0].parts[0].text);
    assert.equal(payload.references[0].id, k.id);
    assert.match(payload.references[0].content, /เว็บไซต์สมาคม/);
    assert.ok(!JSON.stringify(payload).includes('เนื้อหาลับ'));
    assert.match(call.body.systemInstruction.parts[0].text, /เป็นทางการ/);
    assert.match(call.body.systemInstruction.parts[0].text, /เรียงขั้นตอน/);
    assert.equal(result.reply.text, '1. เข้าเว็บไซต์สมาคม\n2. เลือกเมนูสมัครสมาชิก');
  } finally {
    await f.close();
  }
});

test('greetings work in knowledge-only mode without invoking Vertex or handing over', async () => {
  const f = await fixture();
  try {
    await f.behavior({ mode: 'knowledge_only' });
    for (const greeting of [
      'สวัสดีครับ',
      'สวัสดีครับผม',
      'สวัสดีค่ะ 😊',
      'สวัสดีครับมีเรื่องสอบถามครับ',
      'Hello!',
    ]) {
      const result = await f.say(await f.waiting(), greeting);
      assert.equal(result.reply.metadata.handover, false, greeting);
      assert.equal(result.reply.metadata.response_kind, 'general');
    }
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('live Vertex failure collects details without pasting published prose and records a safe diagnostic', async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE knowledge SET status='ARCHIVED'");
    const title = 'สมาคมนี้มีชื่อทางการว่าอะไร';
    const content =
      'ชื่อเต็มคือ สมาคมนิสิตเก่าวิทยาศาสตร์ จุฬาลงกรณ์มหาวิทยาลัย (ส.น.ว.จ.) ภาษาอังกฤษ Chulalongkorn University Science Alumni หรือ C.U.S.A';
    const [k] = await f.db.query(
      "INSERT INTO knowledge(title,content,published_title,published_content,category,status,created_by,updated_by) VALUES($1,$2,$1,$2,'ทั่วไป','PUBLISHED',$3,$3) RETURNING id",
      [title, content, DEMO_AGENTS[0].id],
    );
    f.failProvider(403);
    const result = await f.say(await f.waiting(), title);
    assert.equal(result.reply.metadata.handover, false);
    assert.notEqual(result.reply.text, content);
    assert.equal(result.reply.metadata.response_kind, 'clarify');
    assert.equal(result.reply.metadata.model, 'service-dialogue');
    assert.deepEqual(result.reply.metadata.knowledge_used, []);
    assert.equal(result.reply.metadata.knowledge[0].title, title);
    assert.match(result.reply.metadata.provider_error, /HTTP 403/);
    assert.ok(!JSON.stringify(result.reply).includes('synthetic private provider body'));
    const request = f.calls.find((c) => c.url.endsWith(':generateContent'))!;
    assert.equal(JSON.parse(request.body.contents[0].parts[0].text).references[0].content, content);
    assert.equal(
      (
        await f.db.query('SELECT status FROM conversations WHERE id=$1', [
          result.reply.conversation_id,
        ])
      )[0].status,
      'BOT',
    );
    const unknown = await f.say(await f.waiting(), 'zzzxxyy');
    assert.equal(unknown.reply.metadata.pending_handover_reason, 'PROVIDER_ERROR');
    assert.match(unknown.reply.metadata.provider_error, /HTTP 403/);
    await f.db.query('UPDATE knowledge SET published_content=$2 WHERE id=$1', [
      k.id,
      content.repeat(50),
    ]);
    const tooLong = await f.say(await f.waiting(), title);
    assert.equal(tooLong.reply.metadata.pending_handover_reason, 'PROVIDER_ERROR');
    assert.ok(tooLong.reply.text.length <= 4500, 'never queue an oversized raw fallback for LINE');
  } finally {
    await f.close();
  }
});
