import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getConfig, type Config } from '../server/config.js';
import { openDatabase, type Database } from './database.js';
import { buildApp } from '../server/app.js';
import { DEMO_AGENTS } from '../server/seed.js';
import {
  extractDocument,
  documentChunks,
  ingestDocument,
  uploadDocument,
} from '../server/documents.js';
import {
  analyzeConversation as realAnalyzeConversation,
  queueAnalysis,
  queueIdleAnalyses,
  draftFromGap,
} from '../server/insights.js';
import { encrypt } from '../server/security.js';
import { revokeMessageData } from '../server/training.js';
import { Worker } from '../server/worker.js';

const analyzeConversation = (...args: Parameters<typeof realAnalyzeConversation>) =>
  realAnalyzeConversation(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    async () => 'synthetic-access-token',
  );

let db: Database, app: FastifyInstance, config: Config, directory: string, cookie: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cusa-knowledge-'));
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
async function login(id: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/demo',
    headers: { origin: config.origin },
    payload: { agentId: id },
  });
  assert.equal(r.statusCode, 200);
  return `${r.cookies[0].name}=${r.cookies[0].value}`;
}
const headers = () => ({ cookie, origin: config.origin });
async function source(question = 'คำถามพิเศษที่ยังไม่มีคู่มือ xyzzy') {
  const [u] = await db.query(
    `INSERT INTO users(line_user_id,name,email) VALUES($1,'สมาชิกสมมติ','member@example.org') RETURNING id`,
    ['U' + randomUUID()],
  );
  const [c] = await db.query(`INSERT INTO conversations(user_id) VALUES($1) RETURNING *`, [u.id]);
  const [m] = await db.query(
    `INSERT INTO messages(conversation_id,sender_type,encrypted_text,redacted_text) VALUES($1,'USER',$2,$3) RETURNING *`,
    [c.id, encrypt(question, config.encryptionKey), question],
  );
  return { c, m };
}
async function close(id: string) {
  await db.query(
    `UPDATE conversations SET status='CLOSED',closed_at=now(),resolution='RESOLVED' WHERE id=$1`,
    [id],
  );
}
const aiConfig = () => ({
  ...config,
  demo: false,
  analyticsEnabled: true,
  vertexProject: 'synthetic-project',
  vertexModel: 'test-model',
});
const aiResult = () => ({
  intent: 'สอบถามวิธีใช้งาน',
  summary: 'สมาชิกขอคำแนะนำเพิ่มเติม',
  sentiment: 'neutral',
  outcome: 'unknown',
  interest_tags: ['บริการสมาชิก'],
  missing_question_ids: [] as string[],
});
function response(result: unknown, finishReason = 'STOP') {
  return new Response(
    JSON.stringify({
      candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(result) }] } }],
    }),
    { status: 200 },
  );
}
// Minimal, valid PDF with its own xref offsets; no network fixture dependency.
function pdf(text = 'CUSA handbook membership support') {
  const stream = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(out);
}

test('PDF parser extracts source pages; scanned, corrupt, binary and oversized inputs fail clearly', async () => {
  const pages = await extractDocument(pdf(), 'application/pdf');
  assert.equal(pages.length, 1);
  assert.match(pages[0].text, /CUSA handbook/);
  assert.throws(() => documentChunks([{ page: 1, text: '  ' }]), /OCR/);
  await assert.rejects(extractDocument(Buffer.from('%PDF-invalid'), 'application/pdf'), /PDF/);
  await assert.rejects(extractDocument(Buffer.from([0xff]), 'text/plain'), /UTF-8/);
  await assert.rejects(extractDocument(Buffer.from('bad\0file'), 'text/plain'), /ไบนารี/);
  await assert.rejects(extractDocument(Buffer.alloc(8 * 1024 * 1024 + 1), 'text/plain'), /8 MB/);
  const chunks = documentChunks([{ page: 2, text: 'ข้อมูลสมาชิก '.repeat(1000) }]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.page === 2 && c.text.length <= 3000));
});

test('uploaded originals are encrypted; ingestion is idempotent and chunks require a different approver; archive removes retrieval', async () => {
  const title = 'คู่มือพิเศษ',
    text = 'ข้อกำหนดพิเศษของสมาชิกที่ได้รับการตรวจสอบแล้ว';
  const doc = await uploadDocument(db, config, DEMO_AGENTS[0].id, {
    filename: '../คู่มือ.txt',
    title,
    category: 'ทั่วไป',
    bytes: Buffer.from(text),
  });
  assert.ok(!(await readFile(join(directory, 'attachments', doc.id), 'utf8')).includes(text));
  await ingestDocument(db, config, doc.id);
  await ingestDocument(db, config, doc.id);
  const chunks = await db.query(`SELECT * FROM knowledge WHERE document_id=$1`, [doc.id]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].status, 'DRAFT');
  assert.equal(chunks[0].published_content, null);
  let r = await app.inject({
    method: 'POST',
    url: `/api/knowledge/${chunks[0].id}/publish`,
    headers: headers(),
  });
  assert.equal(r.statusCode, 403);
  cookie = await login(DEMO_AGENTS[1].id);
  r = await app.inject({
    method: 'POST',
    url: `/api/knowledge/${chunks[0].id}/publish`,
    headers: headers(),
  });
  assert.equal(r.statusCode, 200);
  assert.ok(
    (await new Worker(db, config).searchKnowledge(text)).some((k) => k.id === chunks[0].id),
  );
  assert.equal(
    (await app.inject({ url: `/api/knowledge/documents/${doc.id}/source` })).statusCode,
    401,
  );
  r = await app.inject({ url: `/api/knowledge/documents/${doc.id}/source`, headers: headers() });
  assert.equal(r.body, text);
  assert.match(String(r.headers['content-disposition']), /attachment/);
  r = await app.inject({
    method: 'POST',
    url: `/api/knowledge/documents/${doc.id}/archive`,
    headers: headers(),
  });
  assert.equal(r.statusCode, 200);
  assert.ok(
    !(await new Worker(db, config).searchKnowledge(text)).some((k) => k.id === chunks[0].id),
  );
  r = await app.inject({
    method: 'PATCH',
    url: `/api/knowledge/${chunks[0].id}`,
    headers: headers(),
    payload: { title, content: text, category: 'ทั่วไป', keywords: [] },
  });
  assert.equal(r.statusCode, 404);
  cookie = await login(DEMO_AGENTS[0].id);
});

test('multipart API enforces size and type without weakening image uploads; archived queued documents never produce drafts', async () => {
  const form = (name: string, content: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `--test-boundary\r\nContent-Disposition: form-data; name="title"\r\n\r\nคู่มือทดสอบ\r\n--test-boundary\r\nContent-Disposition: form-data; name="category"\r\n\r\nทั่วไป\r\n--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from('\r\n--test-boundary--\r\n'),
    ]);
  const upload = (name: string, content: Buffer) =>
    app.inject({
      method: 'POST',
      url: '/api/knowledge/documents',
      headers: { ...headers(), 'content-type': 'multipart/form-data; boundary=test-boundary' },
      payload: form(name, content),
    });
  assert.equal((await upload('bad.pdf', Buffer.from('not a pdf'))).statusCode, 400);
  assert.equal((await upload('bad.exe', Buffer.from('not text'))).statusCode, 400);
  assert.equal((await upload('large.txt', Buffer.alloc(8 * 1024 * 1024 + 1, 65))).statusCode, 413);
  const r = await upload('manual.pdf', pdf());
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id;
  await app.inject({
    method: 'POST',
    url: `/api/knowledge/documents/${id}/archive`,
    headers: headers(),
  });
  await ingestDocument(db, config, id);
  assert.equal((await db.query(`SELECT id FROM knowledge WHERE document_id=$1`, [id])).length, 0);
});

test('only missing knowledge creates gaps; conversion stays draft and withdrawal retracts all derived content', async () => {
  const { c, m } = await source('อยากทราบเรื่องจักรวาลพิเศษ สมาชิกสมมติ member@example.org');
  await db.query(
    "INSERT INTO settings(key,value) VALUES('ai_behavior',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
    [
      JSON.stringify({
        mode: 'knowledge_only',
        tone: 'friendly',
        language: 'auto',
        length: 'short',
        format: 'natural',
        clarificationLimit: 2,
      }),
    ],
  );
  const worker = new Worker(db, config);
  await worker.botReply(m.id);
  await worker.botReply(m.id);
  const gaps = await db.query(`SELECT * FROM knowledge_gaps WHERE message_id=$1`, [m.id]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, 'NO_KNOWLEDGE');
  assert.ok(!gaps[0].question.includes('member@example.org'));
  assert.ok(!gaps[0].question.includes('สมาชิกสมมติ'));
  const request = await source('ขอคุยกับคน');
  await worker.botReply(request.m.id);
  assert.equal(
    (await db.query(`SELECT id FROM knowledge_gaps WHERE message_id=$1`, [request.m.id])).length,
    0,
  );
  const input = {
    title: 'คำถามที่ทดสอบ',
    content: 'คำตอบที่เจ้าหน้าที่ตรวจสอบเรียบร้อยแล้ว',
    category: 'ทั่วไป',
    keywords: [],
  };
  const k = await draftFromGap(db, gaps[0].id, DEMO_AGENTS[0].id, input);
  assert.equal((await draftFromGap(db, gaps[0].id, DEMO_AGENTS[0].id, input)).id, k.id);
  cookie = await login(DEMO_AGENTS[1].id);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/knowledge/${k.id}/publish`,
        headers: headers(),
      })
    ).statusCode,
    200,
  );
  await db.transaction((tx) => revokeMessageData(tx, m.id));
  const [gone] = await db.query(`SELECT * FROM knowledge WHERE id=$1`, [k.id]);
  assert.equal(gone.status, 'ARCHIVED');
  assert.equal(gone.published_content, null);
  assert.equal(gone.content, '[WITHDRAWN]');
  assert.equal(
    (await db.query(`SELECT id FROM knowledge_versions WHERE knowledge_id=$1`, [k.id])).length,
    0,
  );
  assert.equal(
    (await db.query(`SELECT status FROM knowledge_gaps WHERE message_id=$1`, [m.id]))[0].status,
    'REVOKED',
  );
  await assert.rejects(draftFromGap(db, gaps[0].id, DEMO_AGENTS[0].id, input), /ถอน/);
  assert.equal(
    (await db.query(`SELECT status FROM conversations WHERE id=$1`, [c.id]))[0].status,
    'WAITING_FOR_AGENT',
  );
});

test('analysis sends masked public text only; validates JSON and provenance, preserves actual case/member data', async () => {
  const { c, m } = await source(
    'สมาชิกสมมติ ติดต่อ member@example.org โทร 0812345678 ขอรายละเอียดกิจกรรม',
  );
  await close(c.id);
  await db.query(
    `INSERT INTO messages(conversation_id,sender_type,internal,encrypted_text) VALUES($1,'AGENT',true,$2)`,
    [c.id, encrypt('private internal note', config.encryptionKey)],
  );
  await db.query(
    `INSERT INTO messages(conversation_id,sender_type,delivery_status,encrypted_text) VALUES($1,'AGENT','FAILED',$2)`,
    [c.id, encrypt('failed delivery text', config.encryptionKey)],
  );
  await queueAnalysis(db, aiConfig(), c.id);
  const [pending] = await db.query(
    `SELECT revision FROM conversation_analyses WHERE conversation_id=$1`,
    [c.id],
  );
  let called = false;
  await analyzeConversation(db, aiConfig(), c.id, String(pending.revision), async (_url, init) => {
    called = true;
    const body = JSON.parse(String(init?.body));
    const prompt = body.contents[0].parts[0].text;
    assert.ok(!prompt.includes('private internal note'));
    assert.ok(!prompt.includes('failed delivery text'));
    assert.ok(!prompt.includes('member@example.org'));
    assert.ok(!prompt.includes('0812345678'));
    assert.ok(!prompt.includes('สมาชิกสมมติ'));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return response({ ...aiResult(), missing_question_ids: [m.id] });
  });
  assert.ok(called);
  const [analysis] = await db.query(
    `SELECT * FROM conversation_analyses WHERE conversation_id=$1`,
    [c.id],
  );
  assert.equal(analysis.status, 'READY');
  assert.equal(analysis.coverage.selected, 1);
  assert.deepEqual(analysis.source_message_ids, [m.id]);
  assert.equal(
    (await db.query(`SELECT resolution FROM conversations WHERE id=$1`, [c.id]))[0].resolution,
    'RESOLVED',
  );
  assert.deepEqual(
    (await db.query(`SELECT interest_tags FROM users WHERE id=$1`, [c.user_id]))[0].interest_tags,
    [],
  );
  await db.transaction((tx) => revokeMessageData(tx, m.id));
  assert.equal(
    (await db.query(`SELECT * FROM conversation_analyses WHERE conversation_id=$1`, [c.id])).length,
    0,
  );
});

test('new activity during analysis discards stale results; later eligible revision is scheduled and invalid AI sources fail', async () => {
  const { c } = await source();
  await close(c.id);
  await queueAnalysis(db, aiConfig(), c.id);
  const [pending] = await db.query(
    `SELECT revision FROM conversation_analyses WHERE conversation_id=$1`,
    [c.id],
  );
  await analyzeConversation(db, aiConfig(), c.id, String(pending.revision), async () => {
    await db.query(
      `INSERT INTO messages(conversation_id,sender_type,encrypted_text,redacted_text) VALUES($1,'USER',$2,'ข้อความใหม่')`,
      [c.id, encrypt('ข้อความใหม่', config.encryptionKey)],
    );
    return response(aiResult());
  });
  const r = await app.inject({ url: '/api/insights', headers: headers() });
  assert.equal(r.json().analyses.find((a: any) => a.conversation_id === c.id).result, null);
  await queueIdleAnalyses(db, aiConfig());
  const [newer] = await db.query(
    `SELECT revision FROM conversation_analyses WHERE conversation_id=$1`,
    [c.id],
  );
  assert.notEqual(String(newer.revision), String(pending.revision));
  await analyzeConversation(db, aiConfig(), c.id, String(newer.revision), async () =>
    response({ ...aiResult(), missing_question_ids: [randomUUID()] }),
  );
  assert.equal(
    (await db.query(`SELECT status FROM conversation_analyses WHERE conversation_id=$1`, [c.id]))[0]
      .status,
    'FAILED',
  );
  await queueAnalysis(db, aiConfig(), c.id, true);
  await analyzeConversation(db, aiConfig(), c.id, String(newer.revision), async () =>
    response(aiResult(), 'MAX_TOKENS'),
  );
  assert.equal(
    (await db.query(`SELECT status FROM conversation_analyses WHERE conversation_id=$1`, [c.id]))[0]
      .status,
    'FAILED',
  );
});

test('demo and active conversations never trigger automatic AI; manual request requires reviewer', async () => {
  const { c } = await source();
  await assert.rejects(queueAnalysis(db, config, c.id), /โหมดจริง/);
  await assert.rejects(queueAnalysis(db, aiConfig(), c.id), /30 นาที/);
  await db.query(
    `UPDATE messages SET created_at=now()-interval '31 minutes' WHERE conversation_id=$1`,
    [c.id],
  );
  await queueAnalysis(db, aiConfig(), c.id);
  cookie = await login(DEMO_AGENTS[2].id);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/insights/conversations/${c.id}/analyze`,
        headers: headers(),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: '/api/insights', headers: headers() })).json().enabled,
    false,
  );
});
