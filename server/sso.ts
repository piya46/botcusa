import { requestCusaToken } from './sso-tokens.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { CUSA_CALLBACK_PATH } from '../shared/sso.js';
import type { SsoCallbackHandler } from './sso-callback.js';
import type { Config } from './config.js';
import { audit, type Database } from './db.js';
import { queueRichMenu } from './rich-menus.js';
import { AppError, decrypt, encrypt, newToken, tokenHash } from './security.js';
import type { Fetcher } from './providers.js';

export const profileSchema = z.object({
  sub: z.string().uuid(),
  aud: z.string().uuid(),
  roles: z.array(z.string()),
  scope: z.string(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  email_verified: z.literal(true).optional(),
  department: z.string().optional(),
});
export async function exchangeCusaGrant(
  config: Config,
  code: string,
  verifier: string,
  fetcher: Fetcher = fetch,
  requestRefreshToken = false,
) {
  const origin = new URL(config.ssoOrigin);
  const token = await requestCusaToken(
    config,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.origin + CUSA_CALLBACK_PATH,
      code_verifier: verifier,
      ...(requestRefreshToken ? { request_refresh_token: true } : {}),
    },
    fetcher,
  );
  const identity = await fetcher(new URL('/api/sso/userinfo', origin), {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!identity.ok) throw new AppError(401, 'อ่านข้อมูลยืนยันตัวตนไม่ได้ กรุณาเข้าสู่ระบบใหม่');
  const profile = profileSchema.parse(await identity.json());
  if (
    profile.aud !== config.ssoClientId ||
    !profile.scope.split(' ').includes('identity:read') ||
    profile.roles.length === 0
  )
    throw new AppError(403, 'บัญชีนี้ไม่มีสิทธิ์ของบริการ CUSA Member Desk');
  return {
    profile,
    ...token,
  };
}
export async function exchangeCusa(
  config: Config,
  code: string,
  verifier: string,
  fetcher: Fetcher = fetch,
) {
  // Member linking is not an authorization session; discard the provider token afterwards.
  return (await exchangeCusaGrant(config, code, verifier, fetcher)).profile;
}
export function registerSso(
  app: FastifyInstance,
  db: Database,
  config: Config,
  fetcher: Fetcher = fetch,
): SsoCallbackHandler {
  app.get('/api/connect/config', async () => ({
    liffId: config.liffId,
    available:
      !config.demo &&
      Boolean(
        config.ssoClientId && config.ssoApiKey && config.lineLoginChannelId && config.ssoOrigin,
      ),
    demo: config.demo,
  }));
  app.post('/api/connect/start', async (request, reply) => {
    if (
      config.demo ||
      !config.ssoClientId ||
      !config.ssoApiKey ||
      !config.lineLoginChannelId ||
      !config.ssoOrigin
    )
      throw new AppError(503, 'ยังไม่ได้เปิดการเชื่อมต่อ SSO จริง');
    const { idToken } = z.object({ idToken: z.string().min(20).max(8000) }).parse(request.body);
    const verified = await fetcher('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: config.lineLoginChannelId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!verified.ok) throw new AppError(401, 'ยืนยันบัญชี LINE ไม่สำเร็จ');
    const line = z
      .object({
        sub: z.string().regex(/^U[0-9a-f]{32}$/),
        aud: z.string(),
        exp: z.number(),
        iss: z.literal('https://access.line.me'),
      })
      .parse(await verified.json());
    if (line.aud !== config.lineLoginChannelId || line.exp <= Date.now() / 1000)
      throw new AppError(401, 'LINE token ไม่ถูกต้องหรือหมดอายุ');
    const state = newToken(),
      verifier = newToken(),
      browser = newToken();
    await db.query(
      `INSERT INTO sso_transactions(state_hash,browser_hash,line_user_id,verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')`,
      [tokenHash(state), tokenHash(browser), line.sub, encrypt(verifier, config.encryptionKey)],
    );
    reply.setCookie('cusa_link', browser, {
      path: CUSA_CALLBACK_PATH,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600,
    });
    const url = new URL('/api/sso/authorize', config.ssoOrigin);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.ssoClientId,
      redirect_uri: config.origin + CUSA_CALLBACK_PATH,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'identity:read profile email',
    }).toString();
    return { url: url.toString() };
  });
  return async (_request, reply, transaction, code) => {
    try {
      const profile = await exchangeCusa(
        config,
        code,
        decrypt(transaction.verifier, config.encryptionKey),
        fetcher,
      );
      await db.transaction(async (tx) => {
        const [conflict] = await tx.query(
          `SELECT id FROM users WHERE cusa_sub=$1 AND line_user_id<>$2`,
          [profile.sub, transaction.line_user_id],
        );
        if (conflict) throw new AppError(409, 'บัญชี CUSA นี้ผูกกับ LINE อื่นอยู่แล้ว');
        const [user] = await tx.query(
          `INSERT INTO users(line_user_id,name,cusa_sub,email,department,roles,linked_at) VALUES($1,$2,$3,$4,$5,$6,now())
          ON CONFLICT(line_user_id) DO UPDATE SET cusa_sub=excluded.cusa_sub,email=excluded.email,name=COALESCE($7,users.name),department=excluded.department,roles=excluded.roles,linked_at=now(),updated_at=now() RETURNING id`,
          [
            transaction.line_user_id,
            profile.name ?? 'สมาชิก LINE',
            profile.sub,
            profile.email_verified ? (profile.email ?? null) : null,
            profile.department ?? null,
            JSON.stringify(profile.roles),
            profile.name ?? null,
          ],
        );
        if (config.memberMenuId) await queueRichMenu(tx, user.id, config.memberMenuId);
        await audit(tx, null, 'ACCOUNT_LINKED', 'user', user.id, {
          provider: 'CUSA',
          contract: '1.5.0',
        });
      });
      return reply.redirect('/connect?result=success');
    } catch (error) {
      return reply.redirect(
        `/connect?result=${error instanceof AppError && error.statusCode === 409 ? 'conflict' : 'failed'}`,
      );
    }
  };
}
