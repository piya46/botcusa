import { z } from 'zod';
import type { StaffAccount } from '../shared/types.js';
import type { Config } from './config.js';
import { audit, type Database, type Queryable } from './db.js';
import { AppError } from './security.js';
import { bindStaffLine, verifiedStaffLine, type AuthenticatedStaff } from './staff-line.js';
import { verifyLineIdentity } from './line-profiles.js';
import type { Fetcher } from './providers.js';

const lineUid = z.string().regex(/^U[0-9a-f]{32}$/);
export const accountLineBody = z
  .object({
    source: z.literal('OA_LINK'),
    accountId: z.string().uuid(),
    expectedCurrentUserId: lineUid.nullable(),
    lineIdToken: z.string().min(20).max(8000),
  })
  .strict();
export const accountLinePreference = z
  .object({
    accountId: z.string().uuid(),
    expectedCurrentUserId: lineUid.nullable(),
    enabled: z.boolean(),
  })
  .strict();
export const accountLineRemoval = accountLinePreference.omit({ enabled: true });

export async function staffAccount(
  db: Queryable,
  config: Config,
  actor: AuthenticatedStaff,
): Promise<StaffAccount> {
  const [agent] = await db.query('SELECT * FROM agents WHERE id=$1', [actor.id]);
  if (!agent?.active) throw new AppError(403, 'บัญชีถูกปิดใช้งาน');
  return {
    agent: { id: actor.id, name: actor.name, email: actor.email, role: actor.role },
    demo: config.demo,
    line: {
      userId: agent.line_user_id,
      source: agent.line_identity_source,
      verified:
        Boolean(verifiedStaffLine(config, agent)) &&
        (agent.line_identity_source !== 'SSO' || actor.verifiedLineUserId === agent.line_user_id),
      enabled: agent.line_alerts_enabled,
    },
    lineManagedBySso: config.ssoLineSameProvider,
    canLinkLine:
      !config.demo &&
      !config.ssoLineSameProvider &&
      Boolean(config.liffId && config.lineLoginChannelId),
  };
}

async function lockOwnLine(
  tx: Queryable,
  actor: AuthenticatedStaff,
  input: { accountId: string; expectedCurrentUserId: string | null },
) {
  if (input.accountId !== actor.id)
    throw new AppError(403, 'บัญชีที่เข้าสู่ระบบเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่');
  const [agent] = await tx.query('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [actor.id]);
  if (!agent?.active) throw new AppError(403, 'บัญชีถูกปิดใช้งาน');
  if (agent.line_user_id !== input.expectedCurrentUserId)
    throw new AppError(409, 'บัญชี LINE เปลี่ยนแล้ว กรุณาโหลดหน้าใหม่ก่อนยืนยัน');
  return agent;
}

export async function confirmStaffLine(
  db: Database,
  config: Config,
  actor: AuthenticatedStaff,
  input: z.infer<typeof accountLineBody>,
  fetcher: Fetcher,
) {
  if (config.demo) throw new AppError(400, 'โหมดทดลองไม่เชื่อมบัญชี LINE จริง');
  if (config.ssoLineSameProvider)
    throw new AppError(403, 'บัญชี LINE จัดการผ่าน CUSA SSO เท่านั้น');
  if (input.accountId !== actor.id) throw new AppError(403, 'ยืนยัน LINE ได้เฉพาะบัญชีของคุณ');
  const line = {
    userId: await verifyLineIdentity(config, input.lineIdToken, fetcher),
    channelId: config.lineLoginChannelId,
  };
  await db.transaction(async (tx) => {
    await lockOwnLine(tx, actor, input);
    await bindStaffLine(tx, actor.id, line, input.source);
  });
  return staffAccount(db, config, actor);
}

export async function updateOwnLine(
  db: Database,
  config: Config,
  actor: AuthenticatedStaff,
  input: z.infer<typeof accountLinePreference> | z.infer<typeof accountLineRemoval>,
  remove = false,
) {
  if (remove && config.ssoLineSameProvider)
    throw new AppError(403, 'บัญชี LINE จัดการผ่าน CUSA SSO เท่านั้น');
  await db.transaction(async (tx) => {
    const agent = await lockOwnLine(tx, actor, input);
    const enabled = 'enabled' in input && input.enabled;
    if (
      !remove &&
      enabled &&
      (actor.role === 'REVIEWER' ||
        !verifiedStaffLine(config, agent) ||
        (agent.line_identity_source === 'SSO' && actor.verifiedLineUserId !== agent.line_user_id))
    )
      throw new AppError(400, 'ยืนยัน LINE ด้วยบัญชีที่มีสิทธิ์รับเคสก่อนเปิดแจ้งเตือน');
    if (remove) {
      await tx.query(
        'UPDATE agents SET line_user_id=NULL,line_identity_source=NULL,line_login_channel_id=NULL,line_alerts_enabled=false WHERE id=$1',
        [actor.id],
      );
    } else {
      await tx.query('UPDATE agents SET line_alerts_enabled=$2 WHERE id=$1', [actor.id, enabled]);
    }
    if (remove || !enabled) {
      await tx.query(
        "UPDATE notifications SET line_status='CANCELLED',line_payload=NULL,line_error='เจ้าหน้าที่เปลี่ยนการเชื่อมต่อ LINE' WHERE agent_id=$1 AND line_status='PENDING'",
        [actor.id],
      );
    }
    await audit(
      tx,
      actor.id,
      remove ? 'STAFF_LINE_UNLINKED' : 'STAFF_LINE_PREFERENCE',
      'agent',
      actor.id,
      { enabled: !remove && enabled },
    );
  });
  return staffAccount(db, config, actor);
}
