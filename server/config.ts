import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Config = ReturnType<typeof getConfig>;
export function getConfig(env: NodeJS.ProcessEnv = process.env) {
  const demo = (env.APP_MODE ?? 'demo') === 'demo';
  if (!['demo', 'live'].includes(env.APP_MODE ?? 'demo'))
    throw new Error('APP_MODE must be demo or live');
  const dataDir = resolve(env.DATA_DIR ?? '.data');
  const origin = env.APP_ORIGIN ?? 'http://localhost:5180';
  const host = env.HOST ?? '127.0.0.1';
  if (demo && !['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('Demo must bind to loopback only');
  if (
    !demo &&
    (!env.DATABASE_URL ||
      !env.DATA_ENCRYPTION_KEY ||
      !origin.startsWith('https://') ||
      (env.ADMIN_PASSWORD?.length ?? 0) < 12)
  ) {
    throw new Error(
      'Live mode requires DATABASE_URL, DATA_ENCRYPTION_KEY, HTTPS APP_ORIGIN and ADMIN_PASSWORD (12+ characters)',
    );
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let encryptionKey: Buffer;
  if (env.DATA_ENCRYPTION_KEY) encryptionKey = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
  else {
    const keyFile = resolve(dataDir, 'encryption.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    encryptionKey = readFileSync(keyFile);
  }
  if (encryptionKey.length !== 32) throw new Error('Encryption key must contain exactly 32 bytes');
  const days = (value: string | undefined, fallback: number) => {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('Retention must be 1–3650 days');
    return n;
  };
  return {
    demo,
    dataDir,
    origin: new URL(origin).origin,
    host,
    port: Number(env.PORT ?? 3001),
    databaseUrl: env.DATABASE_URL,
    encryptionKey,
    adminEmail: env.ADMIN_EMAIL ?? 'admin@cusa.local',
    adminPassword: env.ADMIN_PASSWORD,
    lineSecret: env.LINE_CHANNEL_SECRET ?? '',
    lineToken: env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    lineLoginChannelId: env.LINE_LOGIN_CHANNEL_ID ?? '',
    liffId: env.LIFF_ID ?? '',
    memberMenuId: env.LINE_MEMBER_RICH_MENU_ID ?? '',
    guestMenuId: env.LINE_GUEST_RICH_MENU_ID ?? '',
    agentAlertId: env.LINE_AGENT_ALERT_USER_ID ?? '',
    supervisorAlertId: env.LINE_SUPERVISOR_ALERT_USER_ID ?? '',
    geminiKey: env.GEMINI_API_KEY ?? '',
    geminiModel: env.GEMINI_MODEL ?? '',
    embeddingModel: env.GEMINI_EMBEDDING_MODEL ?? '',
    ssoOrigin: env.CUSA_SSO_ORIGIN ?? '',
    ssoClientId: env.CUSA_CLIENT_ID ?? '',
    ssoApiKey: env.CUSA_API_KEY ?? '',
    chatRetentionDays: days(env.CHAT_RETENTION_DAYS, 180),
    datasetRetentionDays: days(env.DATASET_RETENTION_DAYS, 180),
  };
}
