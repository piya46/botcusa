import type { Agent } from '../shared/types.js';
import type { Config } from './config.js';
import { audit, enqueue, type Database, type Queryable } from './db.js';
import { AppError, decrypt, encrypt } from './security.js';
import { lineRequest, type Fetcher } from './providers.js';

export async function configureAgentLine(
  db: Database,
  actor: Agent,
  id: string,
  input: { userId: string | null; enabled: boolean },
) {
  if (actor.role !== 'ADMIN') throw new AppError(403, 'ต้องมีสิทธิ์ผู้ดูแลระบบ');
  if ((input.userId && !/^U[0-9a-f]{32}$/.test(input.userId)) || (input.enabled && !input.userId))
    throw new AppError(400, 'ระบุ LINE User ID รูปแบบ U ตามด้วยเลขฐานสิบหก 32 ตัว');
  return db.transaction(async (tx) => {
    const [a] = await tx.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [id]);
    if (!a || !a.active || a.role === 'REVIEWER')
      throw new AppError(400, 'เลือกเจ้าหน้าที่ที่รับเคสและใช้งานอยู่');
    if (a.line_user_id !== input.userId || a.line_alerts_enabled !== input.enabled) {
      await tx.query(`UPDATE agents SET line_user_id=$2,line_alerts_enabled=$3 WHERE id=$1`, [
        id,
        input.userId,
        input.enabled,
      ]);
      // Never retarget an existing retry key when the administrator changes the recipient.
      await tx.query(
        `UPDATE notifications SET line_status='CANCELLED',line_payload=NULL,line_error='การตั้งค่าผู้รับเปลี่ยนแล้ว' WHERE agent_id=$1 AND line_status='PENDING'`,
        [id],
      );
      await audit(tx, actor.id, 'AGENT_LINE_CONFIGURED', 'agent', id, {
        enabled: input.enabled,
        hasRecipient: Boolean(input.userId),
      });
    }
    return { ok: true };
  });
}

export async function queueTransferLine(
  tx: Queryable,
  config: Config,
  notificationId: string,
  agentId: string,
  title: string,
  conversationId: string,
) {
  // Configuration updates and delivery use this same lock before touching the notification.
  const [agent] = await tx.query(
    `SELECT line_user_id,line_alerts_enabled,active FROM agents WHERE id=$1 FOR SHARE`,
    [agentId],
  );
  if (
    !agent?.active ||
    !agent.line_alerts_enabled ||
    !agent.line_user_id ||
    (!config.demo && !config.lineToken)
  )
    return;
  const payload = {
    to: agent.line_user_id,
    messages: [
      {
        type: 'text',
        text: `${title}\nมีงานส่งต่อรอรับ กรุณาเปิดเคสเพื่อดูรายละเอียด\n${config.origin}/admin/inbox?case=${conversationId}`,
      },
    ],
  };
  await tx.query(`UPDATE notifications SET line_status='PENDING',line_payload=$2 WHERE id=$1`, [
    notificationId,
    encrypt(JSON.stringify(payload), config.encryptionKey),
  ]);
  await enqueue(tx, 'TRANSFER_LINE_ALERT', { notificationId }, `transfer-line:${notificationId}`);
}

export async function deliverTransferLine(
  db: Database,
  config: Config,
  id: string,
  fetcher: Fetcher = fetch,
) {
  await db.transaction(async (tx) => {
    const [c] = await tx.query(
      `SELECT * FROM conversations WHERE id=(SELECT conversation_id FROM notifications WHERE id=$1) FOR UPDATE`,
      [id],
    );
    if (!c) return;
    const [a] = await tx.query(
      `SELECT * FROM agents WHERE id=(SELECT agent_id FROM notifications WHERE id=$1) FOR SHARE`,
      [id],
    );
    const [n] = await tx.query(
      `SELECT n.*,(SELECT routing_version FROM case_transfers WHERE id=n.transfer_id) AS routing_version,(SELECT to_team_id FROM case_transfers WHERE id=n.transfer_id) AS to_team_id,(SELECT to_agent_id FROM case_transfers WHERE id=n.transfer_id) AS to_agent_id,n.created_at>now()-interval '23 hours' AS fresh FROM notifications n WHERE n.id=$1 FOR UPDATE`,
      [id],
    );
    if (!n || n.line_status !== 'PENDING') return;
    const payload = n.line_payload
      ? JSON.parse(decrypt(n.line_payload, config.encryptionKey))
      : null;
    const [membership] = await tx.query(
      `SELECT id FROM teams WHERE id=$1 AND active AND EXISTS(SELECT 1 FROM team_members WHERE team_id=$1 AND agent_id=$2) FOR SHARE`,
      [n.to_team_id, n.agent_id],
    );
    if (
      !n.fresh ||
      c.status !== 'WAITING_FOR_AGENT' ||
      c.routing_version !== n.routing_version ||
      c.team_id !== n.to_team_id ||
      (c.assigned_agent_id && c.assigned_agent_id !== n.agent_id) ||
      !membership ||
      !a?.active ||
      a.role === 'REVIEWER' ||
      !a.line_alerts_enabled ||
      !payload ||
      a.line_user_id !== payload.to
    ) {
      await tx.query(
        `UPDATE notifications SET line_status='CANCELLED',line_payload=NULL,line_error='เคสหรือผู้รับเปลี่ยนแล้ว หรือคำแจ้งเตือนหมดอายุ' WHERE id=$1`,
        [id],
      );
      return;
    }
    // Keep the case/recipient locked through the request so a completed transfer cannot notify an old owner.
    await lineRequest(config, '/v2/bot/message/push', payload, id, fetcher);
    await tx.query(
      `UPDATE notifications SET line_status=$2,line_sent_at=now(),line_error=NULL,line_payload=NULL WHERE id=$1`,
      [id, config.demo ? 'SIMULATED' : 'ACCEPTED'],
    );
    await audit(tx, null, 'TRANSFER_LINE_ACCEPTED', 'notification', id, { simulated: config.demo });
  });
}
