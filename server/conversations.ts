import { randomUUID } from 'node:crypto';
import type { Agent } from '../shared/types.js';
import { audit, enqueue, type Database, type Queryable, type Row } from './db.js';
import type { Config } from './config.js';
import { AppError, decrypt, encrypt, redact } from './security.js';

export const conversationSelect = `SELECT c.*, u.name, u.department, u.cusa_sub, u.avatar_color,
  a.name AS assigned_agent_name,t.name AS team_name,
  (SELECT redacted_text FROM messages m WHERE m.conversation_id=c.id AND NOT m.internal AND m.withdrawn_at IS NULL ORDER BY m.created_at DESC,m.sequence DESC LIMIT 1) AS last_message,
  (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id) AS message_count,
  (SELECT status FROM training_examples t WHERE t.conversation_id=c.id ORDER BY t.created_at DESC LIMIT 1) AS training_status
  FROM conversations c JOIN users u ON u.id=c.user_id LEFT JOIN agents a ON a.id=c.assigned_agent_id LEFT JOIN teams t ON t.id=c.team_id`;

export async function getConversation(db: Queryable, id: string) {
  const [row] = await db.query(`${conversationSelect} WHERE c.id=$1`, [id]);
  if (!row) throw new AppError(404, 'ไม่พบบทสนทนา');
  return row;
}
export async function getMessages(db: Queryable, config: Config, id: string): Promise<Row[]> {
  const rows = await db.query(
    `SELECT m.*, a.name AS agent_name FROM messages m LEFT JOIN agents a ON a.id=m.agent_id WHERE conversation_id=$1 ORDER BY m.created_at,m.sequence`,
    [id],
  );
  return rows.map(
    ({
      encrypted_text,
      encrypted_payload,
      reply_token,
      reply_received_at,
      reply_reserved,
      ...m
    }) => ({
      ...m,
      content:
        !m.withdrawn_at && encrypted_payload
          ? JSON.parse(decrypt(encrypted_payload, config.encryptionKey))
          : null,
      text: m.withdrawn_at
        ? 'ข้อความนี้ถูกยกเลิกหรือลบตามนโยบาย'
        : decrypt(encrypted_text, config.encryptionKey),
    }),
  );
}
export async function systemMessage(
  db: Queryable,
  config: Config,
  conversationId: string,
  text: string,
  actorId?: string,
) {
  await db.query(
    `INSERT INTO messages(conversation_id,sender_type,agent_id,encrypted_text,redacted_text,internal) VALUES($1,'SYSTEM',$2,$3,$4,true)`,
    [conversationId, actorId ?? null, encrypt(text, config.encryptionKey), text],
  );
}
export async function claimCase(db: Database, config: Config, actor: Agent, id: string) {
  if (actor.role === 'REVIEWER') throw new AppError(403, 'บัญชีผู้ตรวจทานไม่สามารถรับงานได้');
  return db.transaction(async (tx) => {
    const [current] = await tx.query(`SELECT team_id FROM conversations WHERE id=$1 FOR UPDATE`, [
      id,
    ]);
    if (current?.team_id)
      await tx.query(`SELECT id FROM teams WHERE id=$1 FOR SHARE`, [current.team_id]);
    const [c] = await tx.query(
      `UPDATE conversations SET status='AGENT_IN_CHARGE',assigned_agent_id=$2,claimed_at=now(),updated_at=now()
      WHERE id=$1 AND status IN ('BOT','WAITING_FOR_AGENT')
      AND ($3 OR ((assigned_agent_id IS NULL OR assigned_agent_id=$2) AND (team_id IS NULL OR EXISTS(SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.team_id=conversations.team_id AND tm.agent_id=$2 AND t.active)))) RETURNING *`,
      [id, actor.id, actor.role === 'ADMIN'],
    );
    if (!c)
      throw new AppError(
        409,
        'เคสนี้มีผู้รับงานแล้ว ปิดไปแล้ว หรือส่งให้ผู้รับผิดชอบ/หน่วยงานอื่น',
      );
    await tx.query(
      `UPDATE case_transfers SET accepted_by=$2,accepted_at=now() WHERE conversation_id=$1 AND routing_version=$3 AND accepted_at IS NULL`,
      [id, actor.id, c.routing_version],
    );
    await systemMessage(tx, config, id, `${actor.name} รับเรื่องแล้ว`, actor.id);
    await audit(tx, actor.id, 'CASE_CLAIMED', 'conversation', id);
    return c;
  });
}
export async function closeCase(
  db: Database,
  config: Config,
  actor: Agent,
  id: string,
  resolution: string,
  note: string,
) {
  if (actor.role === 'REVIEWER') throw new AppError(403, 'บัญชีผู้ตรวจทานไม่สามารถปิดเคสได้');
  return db.transaction(async (tx) => {
    const [c] = await tx.query(
      `UPDATE conversations SET status='CLOSED',closed_at=now(),updated_at=now(),resolution=$3,close_note=$4
      WHERE id=$1 AND status='AGENT_IN_CHARGE' AND (assigned_agent_id=$2 OR $5) RETURNING *`,
      [id, actor.id, resolution, redact(note), actor.role === 'ADMIN'],
    );
    if (!c) throw new AppError(409, 'ต้องรับงานก่อนปิดเคส และต้องเป็นผู้ดูแลเคสนี้');
    await systemMessage(
      tx,
      config,
      id,
      'ปิดเคสแล้ว · ข้อความถัดไปจะเริ่มบทสนทนาใหม่กับผู้ช่วย AI',
      actor.id,
    );
    await audit(tx, actor.id, 'CASE_CLOSED', 'conversation', id, { resolution });
    return c;
  });
}
export async function sendAgentMessage(
  db: Database,
  config: Config,
  actor: Agent,
  id: string,
  text: string,
  internal: boolean,
  clientId: string,
) {
  if (actor.role === 'REVIEWER') throw new AppError(403, 'บัญชีผู้ตรวจทานไม่สามารถส่งข้อความได้');
  return db.transaction(async (tx) => {
    const [existing] = await tx.query(`SELECT * FROM messages WHERE client_request_id=$1`, [
      clientId,
    ]);
    if (existing) {
      if (existing.agent_id !== actor.id || existing.conversation_id !== id)
        throw new AppError(409, 'รหัสคำขอซ้ำ');
      return { id: existing.id, delivery_status: existing.delivery_status };
    }
    const [c] = await tx.query(
      `SELECT c.*,u.name FROM conversations c JOIN users u ON c.user_id=u.id WHERE c.id=$1 FOR UPDATE OF c`,
      [id],
    );
    if (!c) throw new AppError(404, 'ไม่พบเคส');
    if (
      c.status !== 'AGENT_IN_CHARGE' ||
      (c.assigned_agent_id !== actor.id && actor.role !== 'ADMIN')
    )
      throw new AppError(409, 'กรุณารับงานก่อนส่งข้อความ หรือให้ผู้ดูแลเคสเป็นผู้ตอบ');
    const messageId = randomUUID();
    await tx.query(
      `INSERT INTO messages(id,conversation_id,sender_type,agent_id,encrypted_text,redacted_text,delivery_status,internal,client_request_id)
      VALUES($1,$2,'AGENT',$3,$4,$5,$6,$7,$8)`,
      [
        messageId,
        id,
        actor.id,
        encrypt(text, config.encryptionKey),
        redact(text, [c.name]),
        internal ? 'RECEIVED' : 'QUEUED',
        internal,
        clientId,
      ],
    );
    if (!internal) await enqueue(tx, 'DELIVERY', { messageId }, `delivery:${messageId}`);
    await tx.query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [id]);
    await audit(
      tx,
      actor.id,
      internal ? 'INTERNAL_NOTE_CREATED' : 'MESSAGE_QUEUED',
      'message',
      messageId,
    );
    return { id: messageId, delivery_status: internal ? 'RECEIVED' : 'QUEUED' };
  });
}
