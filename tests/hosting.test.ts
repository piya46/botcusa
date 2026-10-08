import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../server/config.js';
import { openDatabase, enqueue } from './database.js';
import { buildApp } from '../server/app.js';
import { attachWorkerWakeup } from '../server/runtime.js';
import { Worker, cosineSimilarity } from '../server/worker.js';
import { DEMO_AGENTS } from '../server/seed.js';
import { encrypt } from '../server/security.js';
import { assertMysqlVersion, mysqlConnectionOptions } from '../server/mysql.js';

test('MySQL version checks accept vendor suffixes and reject unsupported TLS URL options', () => {
  for (const version of [
    '8.0.17',
    '8.0.46-0ubuntu0',
    '8.4.0',
    '10.6.0-MariaDB',
    '5.5.5-10.6.22-MariaDB',
    '12.0.2-MariaDB',
  ])
    assert.doesNotThrow(() => assertMysqlVersion(version));
  for (const version of [
    '5.7.44',
    '8.0.16',
    '8.0.16-0ubuntu0',
    '10.5.29-MariaDB',
    '5.5.5-10.5.29-MariaDB',
    'unknown',
    '8.0',
  ])
    assert.throws(() => assertMysqlVersion(version), /Requires MySQL/);
  const url = 'mysql://test:Example%40123%23@localhost:3306/cusa';
  const options = mysqlConnectionOptions(url + '?ssl=true');
  assert.equal(options.password, 'Example@123#');
  assert.equal(options.ssl?.rejectUnauthorized, true);
  assert.equal(mysqlConnectionOptions(url + '?ssl=verify-full').ssl?.rejectUnauthorized, true);
  assert.equal(mysqlConnectionOptions(url).ssl, undefined);
  for (const query of [
    'ssl=',
    'ssl=false',
    'ssl=true&ssl=false',
    'sslmode=require',
    'multipleStatements=true',
  ])
    assert.throws(() => mysqlConnectionOptions(url + '?' + query), /MySQL/);
});

test('HTTP wakes durable work without cron; future work waits and graceful shutdown drains in-flight work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cusa-hosting-'));
  const config = getConfig({ APP_MODE: 'demo', DATA_DIR: directory, WORKER_MODE: 'opportunistic' });
  const db = await openDatabase({ memory: true });
  const worker = new Worker(db, config);
  const app = await buildApp(db, config);
  attachWorkerWakeup(app, worker);
  try {
    const a = DEMO_AGENTS[0];
    await db.query(
      `INSERT INTO agents(id,name,email,password_hash,role) VALUES($1,$2,$3,'unused','ADMIN')`,
      [a.id, a.name, a.email],
    );
    const [u] = await db.query(
      `INSERT INTO users(line_user_id,name) VALUES($1,'ทดสอบโฮสต์') RETURNING id`,
      ['U' + randomUUID().replaceAll('-', '')],
    );
    const [c] = await db.query(
      `INSERT INTO conversations(user_id,status,assigned_agent_id) VALUES($1,'AGENT_IN_CHARGE',$2) RETURNING id`,
      [u.id, a.id],
    );
    const [m] = await db.query(
      `INSERT INTO messages(conversation_id,sender_type,agent_id,encrypted_text,delivery_status) VALUES($1,'AGENT',$2,$3,'QUEUED') RETURNING id`,
      [c.id, a.id, encrypt('งานยังอยู่หลังแอปพัก', config.encryptionKey)],
    );
    await enqueue(
      db,
      'DELIVERY',
      { messageId: m.id },
      'scheduled-test',
      new Date(Date.now() + 3600000),
    );
    await worker.tick();
    assert.equal(
      (await db.query(`SELECT status FROM jobs WHERE dedupe_key='scheduled-test'`))[0].status,
      'PENDING',
    );
    await db.query(
      `UPDATE jobs SET run_at=now()-interval '1 second' WHERE dedupe_key='scheduled-test'`,
    );
    const response = await app.inject('/api/health');
    assert.equal(response.statusCode, 200);
    await worker.stop();
    assert.equal(
      (await db.query(`SELECT delivery_status FROM messages WHERE id=$1`, [m.id]))[0]
        .delivery_status,
      'SIMULATED',
    );
    assert.equal(
      (await db.query(`SELECT status FROM jobs WHERE dedupe_key='scheduled-test'`))[0].status,
      'DONE',
    );
    const [heartbeat] = await db.query(`SELECT value FROM settings WHERE key='worker_heartbeat'`);
    assert.ok(heartbeat.value.at);
    assert.equal((await app.inject('/api/runtime')).statusCode, 401);
  } finally {
    await app.close();
    await worker.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('semantic retrieval ranks published embeddings without a vector extension on MySQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cusa-embedding-'));
  const db = await openDatabase({ memory: true });
  const config = {
    ...getConfig({ APP_MODE: 'demo', DATA_DIR: directory }),
    demo: false,
    vertexProject: 'synthetic-project',
    embeddingModel: 'test-embedding',
  };
  const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  const worker = new Worker(
    db,
    config,
    async () =>
      new Response(JSON.stringify({ predictions: [{ embeddings: { values: vector } }] }), {
        status: 200,
      }),
    async () => 'synthetic-access-token',
  );
  try {
    const a = DEMO_AGENTS[0];
    await db.query(
      `INSERT INTO agents(id,name,email,password_hash,role) VALUES($1,$2,$3,'unused','ADMIN')`,
      [a.id, a.name, a.email],
    );
    const [k] = await db.query(
      `INSERT INTO knowledge(title,content,category,published_title,published_content,created_by,updated_by,status) VALUES('การติดต่อ','ช่องทางสำนักงาน','ทั่วไป','การติดต่อ','ช่องทางสำนักงาน',$1,$1,'PUBLISHED') RETURNING id`,
      [a.id],
    );
    await worker.embedKnowledge(k.id, 1);
    const results = await worker.searchKnowledge('unrelatedwords');
    assert.equal(results[0]?.id, k.id);
    assert.ok(results[0].score > 5);
    await db.query(`UPDATE knowledge SET status='ARCHIVED' WHERE id=$1`, [k.id]);
    assert.equal((await worker.searchKnowledge('unrelatedwords')).length, 0);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1], [1, 0]), 0);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('database constraints, rollback and JSON values survive the MySQL compatibility layer', async () => {
  const db = await openDatabase({ memory: true });
  try {
    const line = 'U' + randomUUID().replaceAll('-', '');
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO users(line_user_id,name) VALUES($1,'ต้อง rollback')`, [line]);
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await db.query('SELECT id FROM users WHERE line_user_id=$1', [line])).length, 0);
    const [u] = await db.query(
      `INSERT INTO users(line_user_id,name) VALUES($1,'ทดสอบ') RETURNING id`,
      [line],
    );
    await db.query('INSERT INTO conversations(user_id) VALUES($1)', [u.id]);
    await assert.rejects(db.query('INSERT INTO conversations(user_id) VALUES($1)', [u.id]));
    await assert.rejects(db.query('INSERT INTO conversations(user_id) VALUES($1)', [randomUUID()]));
    const sensitive = "ข้อความไทย ' OR true; DROP TABLE users; -- $1 ::text";
    await db.query(`INSERT INTO settings(key,value) VALUES('json_scalar',$1)`, [
      JSON.stringify(sensitive),
    ]);
    assert.equal(
      (await db.query(`SELECT value FROM settings WHERE key='json_scalar'`))[0].value,
      sensitive,
    );
    await db.query(
      `INSERT INTO settings(key,value) VALUES('json_scalar',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [JSON.stringify({ one: [1, true, null, 'ไทย'], two: { x: 1 } })],
    );
    assert.deepEqual(
      (await db.query(`SELECT value FROM settings WHERE key='json_scalar'`))[0].value,
      { one: [1, true, null, 'ไทย'], two: { x: 1 } },
    );
  } finally {
    await db.close();
  }
});
