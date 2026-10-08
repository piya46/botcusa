import type { Config } from './config.js';
import { audit, enqueue, type Database } from './db.js';
import { AppError, decrypt, encrypt } from './security.js';
import { readClaimAction } from './line-flex.js';
import { verifiedStaffLine } from './staff-line.js';
import { authenticateStaff } from './staff-sso.js';
import { claimCase } from './conversations.js';
import { lineRequest, type Fetcher } from './providers.js';

export async function processLineClaim(
  db: Database,
  config: Config,
  eventId: string,
  event: any,
  fetcher: Fetcher,
) {
  const destination =
    event.source?.type === 'group'
      ? event.source.groupId
      : event.source?.type === 'room'
        ? event.source.roomId
        : event.source?.userId;
  const action = readClaimAction(config, event.postback?.data, String(destination ?? ''));
  if (!action) return;
  const [already] = await db.query('SELECT id FROM line_claim_events WHERE id=$1', [eventId]);
  if (!already) {
    let failure = 'กรุณาเชื่อม LINE และเข้าสู่ CUSA SSO ก่อนรับเคส';
    try {
      if (config.demo) throw new AppError(403, 'โหมดทดลองไม่รับเคสจาก LINE จริง');
      if (!/^U[0-9a-f]{32}$/.test(event.source?.userId ?? '')) throw new AppError(403, failure);
      const [staff] = await db.query('SELECT * FROM agents WHERE line_user_id=$1 AND active=true', [
        event.source.userId,
      ]);
      if (!staff || !verifiedStaffLine(config, staff)) throw new AppError(403, failure);
      const [session] = await db.query(
        `SELECT s.token_hash FROM auth_sessions s JOIN staff_sso_sessions p ON p.token_hash=s.token_hash WHERE s.agent_id=$1 AND s.expires_at>now() ORDER BY s.expires_at DESC LIMIT 1`,
        [staff.id],
      );
      if (!session) throw new AppError(401, failure);
      const actor = await authenticateStaff(db, config, session.token_hash, fetcher);
      if (
        actor.id !== staff.id ||
        (staff.line_identity_source === 'SSO' && actor.verifiedLineUserId !== event.source.userId)
      )
        throw new AppError(403, failure);
      // Recheck binding after introspection: an administrator may have changed it meanwhile.
      const [current] = await db.query('SELECT * FROM agents WHERE id=$1', [staff.id]);
      if (!current.active || verifiedStaffLine(config, current) !== event.source.userId)
        throw new AppError(403, failure);
      await claimCase(db, config, actor, action.id, {
        expectedVersion: action.version,
        lineEvent: { id: eventId, replyToken: event.replyToken, sourceUserId: event.source.userId },
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409)
        failure = 'รับเคสไม่ได้: มีผู้รับแล้ว ปิดแล้ว หรือส่งต่อไปแล้ว';
      else if (error instanceof AppError && error.statusCode === 503)
        failure = 'ยังตรวจสิทธิ์ SSO ไม่ได้ กรุณาลองใหม่';
      const payload = {
        replyToken: event.replyToken,
        messages: [
          {
            type: 'text',
            text: `${failure}\n${config.origin}/connect/staff\n${config.origin}/admin/inbox?case=${action.id}`,
          },
        ],
      };
      await db.query(
        'INSERT INTO line_claim_events(id,encrypted_response) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',
        [eventId, encrypt(JSON.stringify(payload), config.encryptionKey)],
      );
    }
  }
  await enqueue(db, 'LINE_CLAIM_REPLY', { eventId }, `line-claim-reply:${eventId}`);
}

export async function replyLineClaim(db: Database, config: Config, id: string, fetcher: Fetcher) {
  // Reserve before the request; an unknown Reply result must never reuse its one-shot token.
  const [event] = await db.query(
    `UPDATE line_claim_events SET reply_attempted=true WHERE id=$1 AND NOT reply_attempted AND created_at>now()-interval '45 seconds' RETURNING *`,
    [id],
  );
  if (!event) return;
  const payload = JSON.parse(decrypt(event.encrypted_response, config.encryptionKey));
  if (!payload.replyToken) return;
  try {
    await lineRequest(config, '/v2/bot/message/reply', payload, undefined, fetcher);
  } catch {
    await audit(db, null, 'LINE_CLAIM_REPLY_UNCONFIRMED', 'line_claim_event', id);
  }
}

export async function sendStaffClaimAlert(
  db: Database,
  config: Config,
  job: any,
  fetcher: Fetcher,
) {
  const payload = JSON.parse(decrypt(job.payload.encryptedPayload, config.encryptionKey));
  const [agent] = await db.query('SELECT * FROM agents WHERE id=$1', [job.payload.agentId]);
  if (
    !agent?.active ||
    agent.role === 'REVIEWER' ||
    !agent.line_alerts_enabled ||
    verifiedStaffLine(config, agent) !== payload.to
  )
    return;
  await lineRequest(config, '/v2/bot/message/push', payload, job.id, fetcher);
}
