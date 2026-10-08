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
import { seed, DEMO_AGENTS } from '../server/seed.js';
import { encrypt, decrypt } from '../server/security.js';

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
  const calls: { url: string; body: any; headers: any }[] = [];
  const fetcher = (async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
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
    assert.equal((await f.say(c, 'คำถามที่ไม่มีข้อมูล zxzz')).reply.metadata.handover, true);
    assert.equal(f.calls.length, 0);
    await f.behavior({ mode: 'conversational' });
    c = await f.waiting();
    assert.equal(
      (await f.say(c, 'ตรวจสอบสถานะสมาชิกของฉัน')).reply.metadata.handover_reason,
      'VERIFICATION_REQUIRED',
    );
    assert.equal(f.calls.length, 0);
    c = await f.waiting();
    assert.equal((await f.say(c, 'ขอคุยกับคน')).reply.metadata.handover_reason, 'USER_REQUEST');
    f.decision({
      action: 'answer',
      kind: 'knowledge',
      text: 'รายละเอียดที่โมเดลแต่งขึ้น',
      reference_ids: [randomUUID()],
    });
    c = await f.waiting();
    const result = await f.say(c, 'กิจกรรม xyz จัดเมื่อไหร่');
    assert.equal(result.reply.metadata.handover_reason, 'MODEL_UNCERTAIN');
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
    assert.match(english.reply.text, /Could you describe/);
    assert.equal(f.calls.length, 0);
    await f.behavior({ language: 'th' });
    const thai = await f.say(c, 'Still unclear');
    assert.match(thai.reply.text, /ขอรายละเอียด/);
  } finally {
    await f.close();
  }
});
