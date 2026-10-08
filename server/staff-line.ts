import { z } from 'zod';
import type { Config } from './config.js';
import type { Queryable } from './db.js';
import { audit } from './db.js';
import { AppError } from './security.js';

export const ssoLineSchema = z.object({
  linked: z.boolean(),
  user_id: z.string().optional(),
  login_channel_id: z.string().optional(),
});
export function ssoLineIdentity(
  config: Config,
  profile: { scope: string; line?: z.infer<typeof ssoLineSchema> },
) {
  return config.ssoLineSameProvider &&
    profile.scope.split(' ').includes('line') &&
    profile.line?.linked &&
    /^U[0-9a-f]{32}$/.test(profile.line.user_id ?? '')
    ? { userId: profile.line.user_id!, channelId: profile.line.login_channel_id ?? '' }
    : null;
}
export function verifiedStaffLine(
  config: Config,
  agent: {
    line_user_id?: string | null;
    line_identity_source?: string | null;
    line_login_channel_id?: string | null;
  },
) {
  return agent.line_user_id &&
    ((agent.line_identity_source === 'SSO' && config.ssoLineSameProvider) ||
      (agent.line_identity_source === 'OA_LINK' &&
        Boolean(config.lineLoginChannelId) &&
        agent.line_login_channel_id === config.lineLoginChannelId))
    ? agent.line_user_id
    : null;
}
export async function bindStaffLine(
  tx: Queryable,
  agentId: string,
  line: { userId: string; channelId: string },
  source: 'SSO' | 'OA_LINK',
) {
  const [agent] = await tx.query('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [agentId]);
  const [conflict] = await tx.query('SELECT id FROM agents WHERE line_user_id=$1 AND id<>$2', [
    line.userId,
    agentId,
  ]);
  if (conflict) throw new AppError(409, 'LINE นี้เชื่อมกับเจ้าหน้าที่อีกบัญชีแล้ว');
  if (
    agent.line_user_id === line.userId &&
    agent.line_identity_source === source &&
    agent.line_login_channel_id === line.channelId
  )
    return;
  // Preserve a staff member's opt-out; new links opt into task notifications.
  const enabled =
    agent.role !== 'REVIEWER' && (agent.line_user_id ? agent.line_alerts_enabled : true);
  await tx.query(
    'UPDATE agents SET line_user_id=$2,line_identity_source=$3,line_login_channel_id=$4,line_alerts_enabled=$5 WHERE id=$1',
    [agentId, line.userId, source, line.channelId, enabled],
  );
  await tx.query(
    "UPDATE notifications SET line_status='CANCELLED',line_payload=NULL,line_error='บัญชี LINE เปลี่ยนแล้ว' WHERE agent_id=$1 AND line_status='PENDING'",
    [agentId],
  );
  await audit(tx, agentId, 'STAFF_LINE_LINKED', 'agent', agentId, { source });
}
