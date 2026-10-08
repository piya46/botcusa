import type { Database } from './db.js';
import { lineRecipientType } from '../shared/line.js';

// Only called for signed LINE webhooks. Store destination metadata, never group messages or members.
export async function recordLineChat(
  db: Database,
  event: {
    type?: unknown;
    timestamp?: unknown;
    source?: { type?: unknown; groupId?: unknown; roomId?: unknown };
  },
  receivedAt: Date | string,
) {
  const type = event.source?.type;
  if (type !== 'group' && type !== 'room') return;
  if (!['join', 'leave', 'message'].includes(String(event.type))) return;
  const id = type === 'group' ? event.source?.groupId : event.source?.roomId;
  if (typeof id !== 'string' || lineRecipientType(id) !== type) return;
  const at = typeof event.timestamp === 'number' ? new Date(event.timestamp) : new Date(receivedAt);
  if (!Number.isFinite(at.getTime())) return;
  const active = event.type !== 'leave';
  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO line_chats(id,type,active,last_event_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      [id, type, active, at],
    );
    const [current] = await tx.query(
      'SELECT last_event_at,active FROM line_chats WHERE id=$1 FOR UPDATE',
      [id],
    );
    // A delayed message must not undo a newer leave event. At equal timestamps, leave wins.
    const previous = new Date(current.last_event_at).getTime();
    if (at.getTime() < previous || (at.getTime() === previous && active)) return;
    await tx.query(
      'UPDATE line_chats SET active=$2,last_event_at=$3,updated_at=now() WHERE id=$1',
      [id, active, at],
    );
  });
}
