import type { Agent, CaseTransfer } from '../shared/types.js';
import type { Config } from './config.js';
import { audit, type Database, type Queryable } from './db.js';
import { AppError, encrypt, decrypt, redact } from './security.js';
import { systemMessage } from './conversations.js';
import { queueTransferLine } from './line-notifications.js';

export async function listTeams(db: Queryable) {
  const teams = await db.query('SELECT * FROM teams ORDER BY name');
  const members = await db.query(
    `SELECT tm.team_id,a.id,a.name,a.role FROM team_members tm JOIN agents a ON a.id=tm.agent_id WHERE a.active AND a.role<>'REVIEWER' ORDER BY a.name`,
  );
  return teams.map((team) => ({
    ...team,
    members: members.filter((m) => m.team_id === team.id).map(({ team_id, ...member }) => member),
  }));
}
export async function saveTeam(
  db: Database,
  actor: Agent,
  input: { name: string; description: string; memberIds: string[]; active: boolean },
  id?: string,
) {
  if (actor.role !== 'ADMIN') throw new AppError(403, 'ต้องมีสิทธิ์ผู้ดูแลระบบ');
  return db.transaction(async (tx) => {
    const ids = [...new Set(input.memberIds)];
    const members = await tx.query(
      `SELECT id FROM agents WHERE id=ANY($1::uuid[]) AND active AND role IN ('ADMIN','AGENT')`,
      [ids],
    );
    if (members.length !== ids.length)
      throw new AppError(400, 'เลือกเจ้าหน้าที่ที่ใช้งานอยู่ บัญชีผู้ตรวจทานรับเคสไม่ได้');
    if (id) {
      const [team] = await tx.query(`SELECT id FROM teams WHERE id=$1 FOR UPDATE`, [id]);
      if (!team) throw new AppError(404, 'ไม่พบหน่วยงาน');
      const [open] = await tx.query(
        `SELECT id FROM conversations WHERE team_id=$1 AND status<>'CLOSED' AND (NOT $2::boolean OR (assigned_agent_id IS NOT NULL AND NOT assigned_agent_id=ANY($3::uuid[]))) LIMIT 1`,
        [id, input.active, ids],
      );
      if (open)
        throw new AppError(409, 'ยังมีเคสเปิดอยู่ กรุณาโอนเคสก่อนปิดหน่วยงานหรือนำผู้รับผิดชอบออก');
      await tx.query(`UPDATE teams SET name=$2,description=$3,active=$4 WHERE id=$1`, [
        id,
        input.name,
        input.description,
        input.active,
      ]);
      await tx.query(`DELETE FROM team_members WHERE team_id=$1`, [id]);
    } else {
      const [team] = await tx.query(
        `INSERT INTO teams(name,description,active) VALUES($1,$2,$3) RETURNING id`,
        [input.name, input.description, input.active],
      );
      id = team.id;
    }
    for (const agentId of ids)
      await tx.query(`INSERT INTO team_members(team_id,agent_id) VALUES($1,$2)`, [id, agentId]);
    await audit(tx, actor.id, 'TEAM_SAVED', 'team', id, {
      members: ids.length,
      active: input.active,
    });
    return { id: id! };
  });
}
export async function transferCase(
  db: Database,
  config: Config,
  actor: Agent,
  conversationId: string,
  input: {
    teamId: string;
    agentId: string | null;
    reason: string;
    expectedVersion: number;
    requestId: string;
  },
) {
  if (actor.role === 'REVIEWER') throw new AppError(403, 'บัญชีผู้ตรวจทานไม่สามารถโอนเคสได้');
  return db.transaction(async (tx) => {
    const [c] = await tx.query(`SELECT * FROM conversations WHERE id=$1 FOR UPDATE`, [
      conversationId,
    ]);
    if (!c) throw new AppError(404, 'ไม่พบเคส');
    const [previous] = await tx.query(
      `SELECT id,created_by,conversation_id FROM case_transfers WHERE request_id=$1`,
      [input.requestId],
    );
    if (previous) {
      if (previous.created_by !== actor.id || previous.conversation_id !== conversationId)
        throw new AppError(409, 'รหัสคำขอซ้ำ');
      return { id: previous.id };
    }
    if (c.status === 'CLOSED' || c.routing_version !== input.expectedVersion)
      throw new AppError(409, 'เคสถูกเปลี่ยนหรือปิดแล้ว กรุณารีเฟรช');
    if (
      actor.role !== 'ADMIN' &&
      (c.status !== 'AGENT_IN_CHARGE' || c.assigned_agent_id !== actor.id)
    )
      throw new AppError(403, 'โอนเคสได้เฉพาะผู้รับผิดชอบที่รับงานแล้วหรือผู้ดูแลระบบ');
    const [team] = await tx.query(`SELECT * FROM teams WHERE id=$1 AND active FOR SHARE`, [
      input.teamId,
    ]);
    if (!team) throw new AppError(400, 'หน่วยงานปลายทางไม่พร้อมรับงาน');
    const members = await tx.query(
      `SELECT a.id,a.name FROM team_members tm JOIN agents a ON a.id=tm.agent_id WHERE tm.team_id=$1 AND a.active AND a.role IN ('ADMIN','AGENT')`,
      [input.teamId],
    );
    if (!members.length) throw new AppError(400, 'หน่วยงานนี้ยังไม่มีเจ้าหน้าที่รับงาน');
    const recipient = input.agentId ? members.find((a) => a.id === input.agentId) : null;
    if (input.agentId && !recipient)
      throw new AppError(400, 'ผู้รับผิดชอบต้องอยู่ในหน่วยงานปลายทาง');
    if (c.team_id === input.teamId && c.assigned_agent_id === input.agentId)
      throw new AppError(409, 'หน่วยงานและผู้รับผิดชอบตรงกับเคสปัจจุบัน');
    const [source] = await tx.query(
      `SELECT t.name AS team_name,a.name AS agent_name,u.name AS member_name FROM conversations c LEFT JOIN teams t ON t.id=c.team_id LEFT JOIN agents a ON a.id=c.assigned_agent_id JOIN users u ON u.id=c.user_id WHERE c.id=$1`,
      [conversationId],
    );
    const [transfer] = await tx.query(
      `INSERT INTO case_transfers(conversation_id,from_team_id,to_team_id,from_agent_id,to_agent_id,created_by,from_team_name,to_team_name,from_agent_name,to_agent_name,encrypted_reason,redacted_reason,request_id,routing_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        conversationId,
        c.team_id,
        input.teamId,
        c.assigned_agent_id,
        input.agentId,
        actor.id,
        source.team_name,
        team.name,
        source.agent_name,
        recipient?.name ?? null,
        encrypt(input.reason, config.encryptionKey),
        redact(input.reason, [source.member_name]),
        input.requestId,
        c.routing_version + 1,
      ],
    );
    await tx.query(
      `UPDATE conversations SET team_id=$2,assigned_agent_id=$3,status='WAITING_FOR_AGENT',handover_at=now(),claimed_at=NULL,updated_at=now(),routing_version=routing_version+1,supervisor_alert_status=NULL,supervisor_notified_at=NULL,last_reminded_at=NULL WHERE id=$1`,
      [conversationId, input.teamId, input.agentId],
    );
    await systemMessage(
      tx,
      config,
      conversationId,
      `${actor.name} โอนเคสไป ${team.name} · ${recipient?.name ?? 'รอเจ้าหน้าที่ในหน่วยงานรับงาน'} ดูเหตุผลในประวัติการโอน`,
      actor.id,
    );
    for (const target of (recipient ? [recipient] : members).sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const title = `เคส #${c.number} ส่งต่อให้ ${team.name}`;
      // Match the configuration/delivery lock order before inserting the recipient's notification.
      await tx.query(`SELECT id FROM agents WHERE id=$1 FOR SHARE`, [target.id]);
      const [notification] = await tx.query(
        `INSERT INTO notifications(agent_id,conversation_id,transfer_id,title) VALUES($1,$2,$3,$4) RETURNING id`,
        [target.id, conversationId, transfer.id, title],
      );
      await queueTransferLine(tx, config, notification.id, target.id, title, conversationId);
    }
    await audit(tx, actor.id, 'CASE_TRANSFERRED', 'conversation', conversationId, {
      transferId: transfer.id,
      teamId: input.teamId,
      agentId: input.agentId,
    });
    return { id: transfer.id };
  });
}
export async function transferHistory(db: Queryable, config: Config, conversationId: string) {
  const rows = await db.query<Omit<CaseTransfer, 'reason'> & { encrypted_reason: string | null }>(
    `SELECT t.*,a.name AS created_by_name,r.name AS accepted_by_name FROM case_transfers t JOIN agents a ON a.id=t.created_by LEFT JOIN agents r ON r.id=t.accepted_by WHERE conversation_id=$1 ORDER BY routing_version DESC`,
    [conversationId],
  );
  return rows.map(({ encrypted_reason, ...r }) => ({
    ...r,
    reason: encrypted_reason
      ? decrypt(encrypted_reason, config.encryptionKey)
      : 'เหตุผลถูกลบตามอายุข้อมูล',
  }));
}
