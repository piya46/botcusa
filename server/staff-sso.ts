import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Agent } from '../shared/types.js';
import { staffRole } from '../shared/roles.js';
import type { Config } from './config.js';
import { audit, type Database } from './db.js';
import type { Fetcher } from './providers.js';
import { AppError, decrypt, encrypt, newToken, tokenHash } from './security.js';
import { exchangeCusaGrant, profileSchema } from './sso.js';
import {
  staffAccess,
  loadStaffSession,
  invalidateStaffToken,
  STAFF_SESSION_MS,
} from './staff-refresh.js';

const callbackPath = '/api/auth/sso/callback';
const activeSchema = profileSchema.extend({ active: z.literal(true), exp: z.number().int() });
async function introspect(config: Config, accessToken: string, sub: string, fetcher: Fetcher) {
  let response: Response;
  try {
    response = await fetcher(new URL('/api/sso/introspect', config.ssoOrigin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.ssoApiKey },
      body: JSON.stringify({ token: accessToken }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError(503, 'ตรวจสอบสิทธิ์ CUSA ไม่สำเร็จ กรุณาลองใหม่');
  }
  if (!response.ok) throw new AppError(503, 'ตรวจสอบสิทธิ์ CUSA ไม่สำเร็จ กรุณาลองใหม่');
  const value = activeSchema.safeParse(await response.json().catch(() => null));
  if (
    !value.success ||
    value.data.sub !== sub ||
    value.data.aud !== config.ssoClientId ||
    value.data.exp <= Date.now() / 1000 ||
    !value.data.scope.split(' ').includes('identity:read')
  )
    throw new AppError(401, 'เซสชัน CUSA หมดอายุหรือถูกเพิกถอน กรุณาเข้าสู่ระบบใหม่');
  const role = staffRole(value.data.roles);
  if (!role) throw new AppError(401, 'บัญชี CUSA นี้ไม่มีบทบาทเจ้าหน้าที่ของ Member Desk');
  return { ...value.data, role };
}

// No identity cache: each protected request checks revocation and current application roles.
export async function authenticateStaff(
  db: Database,
  config: Config,
  hash: string,
  fetcher: Fetcher,
): Promise<Agent> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await staffAccess(db, config, hash, fetcher);
    try {
      const identity = await introspect(
        config,
        decrypt(session.encrypted_token, config.encryptionKey),
        session.cusa_sub,
        fetcher,
      );
      const current = await loadStaffSession(db, config, hash);
      // Another process may have rotated while this introspection was in flight. Check the new token.
      if (current.rotation_id || current.encrypted_token !== session.encrypted_token) continue;
      if (session.role !== identity.role)
        await db.query('UPDATE agents SET role=$1 WHERE id=$2', [identity.role, session.id]);
      return { id: session.id, name: session.name, email: session.email, role: identity.role };
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) {
        if (!(await invalidateStaffToken(db, hash, session.encrypted_token))) continue;
      }
      throw error;
    }
  }
  throw new AppError(503, 'กำลังต่ออายุ CUSA SSO กรุณาลองใหม่');
}

export function registerStaffSso(
  app: FastifyInstance,
  db: Database,
  config: Config,
  fetcher: Fetcher = fetch,
) {
  app.post(
    '/api/auth/sso/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      if (
        config.demo ||
        !config.ssoApiKey ||
        !z.string().uuid().safeParse(config.ssoClientId).success ||
        !config.ssoOrigin.startsWith('https://')
      )
        throw new AppError(503, 'ยังไม่ได้ตั้งค่า CUSA SSO สำหรับเจ้าหน้าที่');
      const state = newToken(),
        verifier = newToken(),
        browser = newToken();
      await db.query(
        `INSERT INTO staff_sso_transactions(state_hash,browser_hash,verifier,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`,
        [tokenHash(state), tokenHash(browser), encrypt(verifier, config.encryptionKey)],
      );
      reply.setCookie('cusa_staff_login', browser, {
        path: callbackPath,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600,
      });
      const url = new URL('/api/sso/authorize', config.ssoOrigin);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.ssoClientId,
        redirect_uri: config.origin + callbackPath,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: 'identity:read profile email',
      }).toString();
      return { url: url.toString() };
    },
  );
  app.get(callbackPath, async (request, reply) => {
    const parsed = z
      .object({
        state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
        code: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .optional(),
        error: z.string().optional(),
      })
      .safeParse(request.query);
    const browser = request.cookies.cusa_staff_login;
    reply.clearCookie('cusa_staff_login', { path: callbackPath, secure: true, sameSite: 'lax' });
    if (!parsed.success || !browser || config.demo) return reply.redirect('/admin?auth=invalid');
    const [transaction] = await db.query(
      'DELETE FROM staff_sso_transactions WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *',
      [tokenHash(parsed.data.state), tokenHash(browser)],
    );
    if (!transaction || !parsed.data.code || parsed.data.error)
      return reply.redirect('/admin?auth=invalid');
    try {
      const grant = await exchangeCusaGrant(
        config,
        parsed.data.code,
        decrypt(transaction.verifier, config.encryptionKey),
        fetcher,
        callbackPath,
        true,
      );
      const identity = await introspect(config, grant.accessToken, grant.profile.sub, fetcher);
      const accessExpiresAt = Math.min(grant.expiresAt, identity.exp * 1000);
      const expiresAt =
        grant.refreshToken && grant.refreshExpiresAt
          ? Math.min(Date.now() + STAFF_SESSION_MS, grant.refreshExpiresAt)
          : accessExpiresAt;
      if (accessExpiresAt <= Date.now()) throw new AppError(401, 'เซสชันหมดอายุ');
      const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
      if (maxAge < 1) throw new AppError(401, 'เซสชันหมดอายุ');
      const token = newToken(),
        hash = tokenHash(token);
      await db.transaction(async (tx) => {
        let [account] = await tx.query(
          `SELECT a.* FROM staff_identities i JOIN agents a ON a.id=i.agent_id WHERE i.cusa_sub=$1 AND i.application_id=$2 FOR UPDATE`,
          [identity.sub, config.ssoClientId],
        );
        if (account && !account.active) throw new AppError(403, 'บัญชีถูกปิดใช้งาน');
        if (!account) {
          // sub is the identity key. Email is never used to link to a pre-existing local account.
          const email =
            grant.profile.email_verified && grant.profile.email
              ? grant.profile.email
              : `${identity.sub}@sso.invalid`;
          const [conflict] = await tx.query('SELECT id FROM agents WHERE lower(email)=lower($1)', [
            email,
          ]);
          if (conflict) throw new AppError(409, 'บัญชีอีเมลนี้มีอยู่แล้ว ต้องย้ายบัญชีเดิมก่อน');
          [account] = await tx.query(
            'INSERT INTO agents(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING *',
            [grant.profile.name || 'เจ้าหน้าที่ CUSA', email, '!SSO_ONLY', identity.role],
          );
          await tx.query(
            'INSERT INTO staff_identities(cusa_sub,application_id,agent_id) VALUES($1,$2,$3)',
            [identity.sub, config.ssoClientId, account.id],
          );
        } else {
          await tx.query('UPDATE agents SET role=$1,name=$2 WHERE id=$3', [
            identity.role,
            grant.profile.name || account.name,
            account.id,
          ]);
        }
        if (request.cookies.cusa_session)
          await tx.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
            tokenHash(request.cookies.cusa_session),
          ]);
        await tx.query(
          'INSERT INTO auth_sessions(token_hash,agent_id,expires_at) VALUES($1,$2,$3)',
          [hash, account.id, new Date(expiresAt)],
        );
        await tx.query(
          'INSERT INTO staff_sso_sessions(token_hash,cusa_sub,encrypted_token) VALUES($1,$2,$3)',
          [hash, identity.sub, encrypt(grant.accessToken, config.encryptionKey)],
        );
        if (grant.refreshToken && grant.refreshExpiresAt) {
          await tx.query(
            `INSERT INTO staff_sso_refresh(token_hash,encrypted_refresh_token,access_expires_at,refresh_expires_at,api_key_hash,scopes)
            VALUES($1,$2,$3,$4,$5,$6)`,
            [
              hash,
              encrypt(grant.refreshToken, config.encryptionKey),
              new Date(accessExpiresAt),
              new Date(expiresAt),
              tokenHash(config.ssoApiKey),
              grant.scope,
            ],
          );
        }
        await audit(tx, account.id, 'LOGIN_SSO', 'agent', account.id, { role: identity.role });
      });
      reply.setCookie('cusa_session', token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge,
      });
      return reply.redirect('/admin/overview');
    } catch (error) {
      const reason = error instanceof AppError && error.statusCode === 409 ? 'conflict' : 'denied';
      return reply.redirect(`/admin?auth=${reason}`);
    }
  });
}
