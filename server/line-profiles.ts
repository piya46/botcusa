import { z } from 'zod';
import type { Config } from './config.js';
import { enqueue, type Database, type Queryable } from './db.js';
import { lineRequest, type Fetcher } from './providers.js';
import { AppError } from './security.js';

export async function verifyLineIdentity(config: Config, idToken: string, fetcher: Fetcher) {
  if (!config.lineLoginChannelId) throw new AppError(503, 'ยังไม่ได้ตั้ง LINE Login Channel ID');
  const response = await fetcher('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: config.lineLoginChannelId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new AppError(401, 'ยืนยันบัญชี LINE ไม่สำเร็จ');
  const identity = z
    .object({
      sub: z.string().regex(/^U[0-9a-f]{32}$/),
      aud: z.string(),
      exp: z.number(),
      iss: z.literal('https://access.line.me'),
    })
    .parse(await response.json());
  if (identity.aud !== config.lineLoginChannelId || identity.exp <= Date.now() / 1000)
    throw new AppError(401, 'LINE token ไม่ถูกต้องหรือหมดอายุ');
  return identity.sub;
}

export async function queueLineProfile(db: Queryable, config: Config, userId: string) {
  if (config.demo || !config.lineToken) return;
  const [user] = await db.query('SELECT line_profile_checked_at,blocked FROM users WHERE id=$1', [
    userId,
  ]);
  if (
    !user ||
    user.blocked ||
    (user.line_profile_checked_at &&
      Date.now() - new Date(user.line_profile_checked_at).getTime() < 86400000)
  )
    return;
  await enqueue(
    db,
    'LINE_PROFILE',
    { userId },
    `line-profile:${userId}:${new Date().toISOString().slice(0, 10)}`,
  );
}

export async function updateLineProfile(
  db: Database,
  config: Config,
  userId: string,
  fetcher: Fetcher,
) {
  if (config.demo) return;
  const [user] = await db.query('SELECT line_user_id,blocked FROM users WHERE id=$1', [userId]);
  if (!user || user.blocked || !/^U[0-9a-f]{32}$/.test(user.line_user_id)) return;
  const result = await lineRequest(
    config,
    `/v2/bot/profile/${user.line_user_id}`,
    undefined,
    undefined,
    fetcher,
    'GET',
    4000,
  );
  const profile = z
    .object({
      userId: z.literal(user.line_user_id),
      displayName: z.string().trim().min(1).max(255),
    })
    .parse(result);
  await db.query(
    `UPDATE users SET line_display_name=$2,name=CASE WHEN cusa_sub IS NULL OR name IN ('สมาชิก LINE','ผู้ติดต่อ LINE') THEN $2 ELSE name END,line_profile_checked_at=now(),updated_at=now() WHERE id=$1 AND line_user_id=$3`,
    [userId, profile.displayName, user.line_user_id],
  );
}
