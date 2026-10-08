import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lineRecipientPattern } from '../shared/line.js';
import { vertexSettings } from '../shared/vertex.js';
import { cusaClaimScopes } from '../shared/sso.js';

export type Config = ReturnType<typeof getConfig>;
export function getConfig(env: NodeJS.ProcessEnv = process.env) {
  const demo = (env.APP_MODE ?? 'demo') === 'demo';
  if (!['demo', 'live'].includes(env.APP_MODE ?? 'demo'))
    throw new Error('APP_MODE must be demo or live');
  if (env.WORKER_MODE && !['continuous', 'opportunistic'].includes(env.WORKER_MODE))
    throw new Error('WORKER_MODE must be continuous or opportunistic');
  if (env.CUSA_LINE_SAME_PROVIDER && !['true', 'false'].includes(env.CUSA_LINE_SAME_PROVIDER))
    throw new Error('CUSA_LINE_SAME_PROVIDER must be true or false');
  const dataDir = resolve(env.DATA_DIR ?? '.data');
  const origin = env.APP_ORIGIN ?? 'http://localhost:5180';
  const host = env.HOST ?? '127.0.0.1';
  if (demo && !['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error('Demo must bind to loopback only');
  if (!demo && (!env.DATABASE_URL || !env.DATA_ENCRYPTION_KEY || !origin.startsWith('https://'))) {
    throw new Error('Live mode requires DATABASE_URL, DATA_ENCRYPTION_KEY, HTTPS APP_ORIGIN');
  }
  if (!demo) {
    const sso = z.url().safeParse(env.CUSA_SSO_ORIGIN);
    if (
      !sso.success ||
      new URL(sso.data).protocol !== 'https:' ||
      new URL(sso.data).origin !== sso.data ||
      !z.string().uuid().safeParse(env.CUSA_CLIENT_ID).success ||
      !env.CUSA_API_KEY?.trim()
    )
      throw new Error(
        'Live mode requires HTTPS CUSA_SSO_ORIGIN, CUSA_CLIENT_ID (application UUID) and CUSA_API_KEY',
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
  const lineLoadingSeconds = Number(env.LINE_LOADING_SECONDS ?? 30);
  for (const name of ['LINE_AGENT_ALERT_USER_ID', 'LINE_SUPERVISOR_ALERT_USER_ID'])
    if (env[name]?.trim() && !lineRecipientPattern.test(env[name]!.trim()))
      throw new Error(
        `${name} must be a LINE user (U), group (C), or room (R) ID with 32 hexadecimal characters`,
      );
  if (
    !Number.isInteger(lineLoadingSeconds) ||
    lineLoadingSeconds < 5 ||
    lineLoadingSeconds > 60 ||
    lineLoadingSeconds % 5 !== 0
  )
    throw new Error('LINE_LOADING_SECONDS must be 5–60 in increments of 5');
  return {
    demo,
    dataDir,
    origin: new URL(origin).origin,
    host,
    port: Number(env.PORT ?? 3001),
    databaseUrl: env.DATABASE_URL,
    mysqlSslCa: env.MYSQL_SSL_CA || undefined,
    workerMode:
      (env.WORKER_MODE ??
        (/^(mysql|mariadb):/.test(env.DATABASE_URL ?? '') ? 'opportunistic' : 'continuous')) ===
      'opportunistic'
        ? ('opportunistic' as const)
        : ('continuous' as const),
    encryptionKey,
    lineSecret: env.LINE_CHANNEL_SECRET ?? '',
    lineToken: env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
    lineLoadingEnabled: env.LINE_LOADING_ENABLED !== 'false',
    lineLoadingSeconds,
    lineLoginChannelId: env.LINE_LOGIN_CHANNEL_ID ?? '',
    liffId: env.LIFF_ID ?? '',
    memberMenuId: env.LINE_MEMBER_RICH_MENU_ID ?? '',
    guestMenuId: env.LINE_GUEST_RICH_MENU_ID ?? '',
    agentAlertId: env.LINE_AGENT_ALERT_USER_ID?.trim() ?? '',
    supervisorAlertId: env.LINE_SUPERVISOR_ALERT_USER_ID?.trim() ?? '',
    ...vertexSettings(env),
    analyticsEnabled: env.AI_ANALYTICS_ENABLED === 'true',
    ssoOrigin: env.CUSA_SSO_ORIGIN ?? '',
    ssoClientId: env.CUSA_CLIENT_ID ?? '',
    ssoApiKey: env.CUSA_API_KEY ?? '',
    ssoLineSameProvider: env.CUSA_LINE_SAME_PROVIDER === 'true',
    ssoClaimScopes: cusaClaimScopes(env.CUSA_CLAIM_SCOPES, env.CUSA_LINE_SAME_PROVIDER === 'true'),
    chatRetentionDays: days(env.CHAT_RETENTION_DAYS, 180),
    datasetRetentionDays: days(env.DATASET_RETENTION_DAYS, 180),
  };
}
