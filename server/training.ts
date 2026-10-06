import { createHash } from 'node:crypto';
import type { Agent } from '../shared/types.js';
import type { Config } from './config.js';
import { audit, type Database, type Queryable } from './db.js';
import { AppError, decrypt, redact } from './security.js';

export async function assertTrainingEnabled(db: Queryable) {
  const [policy] = await db.query(`SELECT value FROM settings WHERE key='training_policy'`);
  if (!policy?.value?.enabled || !policy.value.notice_version)
    throw new AppError(409, 'กรุณากำหนดนโยบายและเปิดใช้งานการเตรียมข้อมูลฝึกในหน้าตั้งค่าก่อน');
}
export const splitForConversation = (id: string): 'train' | 'validation' | 'test' => {
  const bucket = createHash('sha256').update(id).digest().readUInt32BE(0) % 10;
  return bucket < 8 ? 'train' : bucket === 8 ? 'validation' : 'test';
};
export async function createExample(
  db: Database,
  config: Config,
  actor: Agent,
  conversationId: string,
  answerMessageId?: string,
) {
  return db.transaction(async (tx) => {
    await assertTrainingEnabled(tx);
    const [c] = await tx.query(
      `SELECT c.*,u.name,u.email FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=$1 FOR UPDATE OF c`,
      [conversationId],
    );
    if (!c || c.status !== 'CLOSED')
      throw new AppError(409, 'ปิดเคสพร้อมบันทึกผลก่อนสร้างตัวอย่างฝึก');
    if (c.resolution !== 'RESOLVED_HUMAN' && c.resolution !== 'RESOLVED_BOT')
      throw new AppError(409, 'เลือกเคสที่ยืนยันว่าแก้ปัญหาแล้วเพื่อสร้างตัวอย่างฝึก');
    const rows = await tx.query(
      `SELECT m.*,a.name AS agent_name FROM messages m LEFT JOIN agents a ON a.id=m.agent_id WHERE conversation_id=$1 AND NOT internal AND withdrawn_at IS NULL AND sender_type IN ('USER','BOT','AGENT') AND delivery_status IN ('RECEIVED','ACCEPTED','SIMULATED') ORDER BY created_at,sequence`,
      [conversationId],
    );
    const answerIndex = answerMessageId
      ? rows.findIndex(
          (m) => m.id === answerMessageId && m.sender_type === 'AGENT' && m.kind === 'text',
        )
      : rows.findLastIndex((m) => m.sender_type === 'AGENT' && m.kind === 'text');
    if (answerIndex < 1)
      throw new AppError(409, 'ยังไม่มีคำตอบเจ้าหน้าที่ที่ส่งสำเร็จสำหรับทำตัวอย่างฝึก');
    const before = rows.slice(0, answerIndex);
    const question = before.findLast((m) => m.sender_type === 'USER' && m.kind === 'text');
    if (!question) throw new AppError(409, 'ไม่พบคำถามต้นทาง');
    const names = [c.name, c.email, ...rows.map((m) => m.agent_name)].filter(Boolean);
    const masked = (m: (typeof rows)[number]) =>
      redact(decrypt(m.encrypted_text, config.encryptionKey), names);
    const context = before
      .filter((m) => m.kind === 'text')
      .map((m) => ({ role: m.sender_type === 'USER' ? 'user' : 'assistant', content: masked(m) }));
    const [example] = await tx.query(
      `INSERT INTO training_examples(conversation_id,source_message_ids,question,answer,context,category,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        conversationId,
        JSON.stringify(rows.slice(0, answerIndex + 1).map((m) => m.id)),
        masked(question),
        masked(rows[answerIndex]),
        JSON.stringify(context),
        c.category,
        actor.id,
      ],
    );
    await audit(tx, actor.id, 'TRAINING_DRAFT_CREATED', 'training_example', example.id);
    return example;
  });
}
export async function reviewExample(db: Database, actor: Agent, id: string, approve: boolean) {
  if (!['ADMIN', 'REVIEWER'].includes(actor.role))
    throw new AppError(403, 'ต้องมีสิทธิ์ผู้ตรวจทาน');
  return db.transaction(async (tx) => {
    await assertTrainingEnabled(tx);
    const [row] = await tx.query(`SELECT * FROM training_examples WHERE id=$1 FOR UPDATE`, [id]);
    if (!row || row.status !== 'DRAFT')
      throw new AppError(409, 'ตัวอย่างนี้ไม่ได้อยู่ระหว่างรอตรวจ');
    if (row.created_by === actor.id)
      throw new AppError(403, 'ผู้สร้างหรือแก้ไขตัวอย่างต้องให้ผู้ตรวจทานอีกคนอนุมัติ');
    const [invalid] = await tx.query(
      `SELECT id FROM messages WHERE id IN (SELECT jsonb_array_elements_text($1)::uuid) AND withdrawn_at IS NOT NULL LIMIT 1`,
      [JSON.stringify(row.source_message_ids)],
    );
    if (invalid) throw new AppError(409, 'ข้อความต้นทางถูกถอนแล้ว ไม่สามารถอนุมัติได้');
    const [result] = await tx.query(
      `UPDATE training_examples SET status=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,
      [id, approve ? 'APPROVED' : 'REJECTED', actor.id],
    );
    await audit(
      tx,
      actor.id,
      approve ? 'TRAINING_APPROVED' : 'TRAINING_REJECTED',
      'training_example',
      id,
      approve ? { privacy_reviewed: true, quality_reviewed: true } : {},
    );
    return result;
  });
}
export async function createDataset(db: Database, actor: Agent, name: string) {
  if (!['ADMIN', 'REVIEWER'].includes(actor.role))
    throw new AppError(403, 'ต้องมีสิทธิ์ผู้ตรวจทาน');
  return db.transaction(async (tx) => {
    await assertTrainingEnabled(tx);
    const examples = await tx.query(
      `SELECT * FROM training_examples WHERE status='APPROVED' ORDER BY created_at FOR UPDATE`,
    );
    if (!examples.length) throw new AppError(409, 'ยังไม่มีตัวอย่างที่ผ่านการอนุมัติ');
    const [dataset] = await tx.query(
      `INSERT INTO datasets(name,created_by) VALUES($1,$2) RETURNING *`,
      [name, actor.id],
    );
    for (const ex of examples) {
      const snapshot = {
        messages: [...ex.context, { role: 'assistant', content: ex.answer }],
        metadata: {
          example_id: ex.id,
          conversation_id: ex.conversation_id,
          category: ex.category,
          reviewed_at: ex.reviewed_at,
        },
      };
      await tx.query(
        `INSERT INTO dataset_items(dataset_id,example_id,split,snapshot) VALUES($1,$2,$3,$4)`,
        [dataset.id, ex.id, splitForConversation(ex.conversation_id), JSON.stringify(snapshot)],
      );
    }
    await audit(tx, actor.id, 'DATASET_CREATED', 'dataset', dataset.id, {
      examples: examples.length,
    });
    return dataset;
  });
}
export async function revokeMessageData(tx: Queryable, messageId: string) {
  await tx.query(
    `UPDATE messages SET encrypted_text=NULL,encrypted_payload=NULL,redacted_text='[WITHDRAWN]',reply_token=NULL,metadata='{}',withdrawn_at=now() WHERE id=$1`,
    [messageId],
  );
  const examples = await tx.query(
    `UPDATE training_examples SET status='REVOKED',question='[WITHDRAWN]',answer='[WITHDRAWN]',context='[]',notes='',updated_at=now() WHERE source_message_ids @> $1::jsonb RETURNING id`,
    [JSON.stringify([messageId])],
  );
  for (const ex of examples)
    await tx.query(`UPDATE dataset_items SET snapshot=NULL,revoked_at=now() WHERE example_id=$1`, [
      ex.id,
    ]);
}
