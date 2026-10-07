import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { Fetcher } from './providers.js';
import { AppError, decrypt, encrypt, tokenHash } from './security.js';
import { requestCusaToken } from './sso-tokens.js';

export const STAFF_SESSION_MS = 8 * 60 * 60 * 1000;
const refreshAheadMs = 30_000;
const interruptedRotationMs = 30_000;
const expired = () =>
  new AppError(401, 'เซสชัน CUSA หมดอายุหรือไม่สามารถต่ออายุได้ กรุณาเข้าสู่ระบบใหม่');
export const deleteStaffSession = (db: Database, hash: string) =>
  db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hash]);

// A late inactive response for an old access token must not delete a freshly rotated session.
export async function invalidateStaffToken(db: Database, hash: string, encryptedToken: string) {
  return db.transaction(async (tx) => {
    const [local] = await tx.query(
      'SELECT token_hash FROM auth_sessions WHERE token_hash=$1 FOR UPDATE',
      [hash],
    );
    if (!local) return true;
    const [token] = await tx.query(
      'SELECT encrypted_token FROM staff_sso_sessions WHERE token_hash=$1',
      [hash],
    );
    const [rotation] = await tx.query(
      'SELECT rotation_id FROM staff_sso_refresh WHERE token_hash=$1',
      [hash],
    );
    if (token?.encrypted_token !== encryptedToken || rotation?.rotation_id) return false;
    await tx.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hash]);
    return true;
  });
}

export async function loadStaffSession(db: Database, config: Config, hash: string) {
  const [session] = await db.query(
    `SELECT a.id,a.name,a.email,a.role,s.expires_at,p.cusa_sub,p.encrypted_token,
      r.encrypted_refresh_token,r.access_expires_at,r.refresh_expires_at,r.api_key_hash,
      r.scopes,r.rotation_id,r.rotation_started_at
     FROM auth_sessions s JOIN agents a ON a.id=s.agent_id
     JOIN staff_sso_sessions p ON p.token_hash=s.token_hash
     JOIN staff_identities i ON i.cusa_sub=p.cusa_sub AND i.agent_id=a.id
     LEFT JOIN staff_sso_refresh r ON r.token_hash=s.token_hash
     WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active=true AND i.application_id=$2`,
    [hash, config.ssoClientId],
  );
  if (!session) throw expired();
  return session;
}

export async function staffAccess(db: Database, config: Config, hash: string, fetcher: Fetcher) {
  const waitUntil = Date.now() + 12_000;
  for (;;) {
    const session = await loadStaffSession(db, config, hash);
    // Sessions established before refresh support retain their short, original lifetime.
    if (!session.api_key_hash) return session;
    if (
      session.api_key_hash !== tokenHash(config.ssoApiKey) ||
      new Date(session.refresh_expires_at).getTime() <= Date.now()
    ) {
      await deleteStaffSession(db, hash);
      throw expired();
    }
    if (session.rotation_id) {
      // The marker is persisted BEFORE the HTTP call. Never reclaim it to retry a used token.
      if (new Date(session.rotation_started_at).getTime() + interruptedRotationMs <= Date.now()) {
        await deleteStaffSession(db, hash);
        throw expired();
      }
      if (Date.now() >= waitUntil) throw new AppError(503, 'กำลังต่ออายุ CUSA SSO กรุณาลองใหม่');
      await sleep(75);
      continue;
    }
    if (new Date(session.access_expires_at).getTime() > Date.now() + refreshAheadMs) return session;

    const rotationId = randomUUID();
    const claim = await db.transaction(async (tx) => {
      // Always lock the local session first, including when persisting a rotated pair.
      const [local] = await tx.query(
        'SELECT expires_at FROM auth_sessions WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',
        [hash],
      );
      if (!local) throw expired();
      const [row] = await tx.query(
        'SELECT * FROM staff_sso_refresh WHERE token_hash=$1 FOR UPDATE',
        [hash],
      );
      if (
        !row ||
        row.rotation_id ||
        new Date(row.access_expires_at).getTime() > Date.now() + refreshAheadMs
      )
        return null;
      if (
        row.api_key_hash !== tokenHash(config.ssoApiKey) ||
        new Date(row.refresh_expires_at).getTime() <= Date.now()
      )
        throw expired();
      await tx.query(
        'UPDATE staff_sso_refresh SET rotation_id=$2,rotation_started_at=now() WHERE token_hash=$1',
        [hash, rotationId],
      );
      return row;
    });
    if (!claim) continue;
    try {
      const refreshToken = decrypt(claim.encrypted_refresh_token, config.encryptionKey);
      const next = await requestCusaToken(
        config,
        { grant_type: 'refresh_token', refresh_token: refreshToken },
        fetcher,
      );
      if (
        !next.refreshToken ||
        !next.refreshExpiresAt ||
        next.refreshToken === refreshToken ||
        !next.scope.split(' ').every((scope) => claim.scopes.split(' ').includes(scope))
      )
        throw expired();
      const refreshExpiresAt = Math.min(
        new Date(claim.refresh_expires_at).getTime(),
        next.refreshExpiresAt,
      );
      if (Math.min(next.expiresAt, refreshExpiresAt) <= Date.now()) throw expired();
      await db.transaction(async (tx) => {
        const [local] = await tx.query(
          'SELECT expires_at FROM auth_sessions WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',
          [hash],
        );
        const [row] = await tx.query(
          'SELECT rotation_id FROM staff_sso_refresh WHERE token_hash=$1 FOR UPDATE',
          [hash],
        );
        // Logout, revocation or a failed rotation may have removed the session while HTTP was in flight.
        if (!local || row?.rotation_id !== rotationId) throw expired();
        await tx.query('UPDATE staff_sso_sessions SET encrypted_token=$2 WHERE token_hash=$1', [
          hash,
          encrypt(next.accessToken, config.encryptionKey),
        ]);
        await tx.query(
          `UPDATE staff_sso_refresh SET encrypted_refresh_token=$2,access_expires_at=$3,
          refresh_expires_at=$4,scopes=$5,rotation_id=NULL,rotation_started_at=NULL WHERE token_hash=$1`,
          [
            hash,
            encrypt(next.refreshToken!, config.encryptionKey),
            new Date(next.expiresAt),
            new Date(refreshExpiresAt),
            next.scope,
          ],
        );
        // Absolute limits only: neither refresh nor activity can move the initial eight-hour deadline.
        await tx.query('UPDATE auth_sessions SET expires_at=$2 WHERE token_hash=$1', [
          hash,
          new Date(Math.min(new Date(local.expires_at).getTime(), refreshExpiresAt)),
        ]);
      });
      return await loadStaffSession(db, config, hash);
    } catch {
      // Includes timeout, malformed response, failed persistence, 429 and 5xx: never resubmit.
      await deleteStaffSession(db, hash);
      throw expired();
    }
  }
}

export async function logoutStaff(db: Database, config: Config, hash: string, fetcher: Fetcher) {
  const [session] = await db.query(
    `SELECT p.encrypted_token,r.encrypted_refresh_token,r.api_key_hash
    FROM staff_sso_sessions p LEFT JOIN staff_sso_refresh r ON r.token_hash=p.token_hash WHERE p.token_hash=$1`,
    [hash],
  );
  // End local authorization regardless of provider availability, without waiting for rotation.
  await deleteStaffSession(db, hash);
  if (!session) return true;
  if (session.api_key_hash && session.api_key_hash !== tokenHash(config.ssoApiKey)) return false;
  try {
    const response = await fetcher(new URL('/api/sso/revoke', config.ssoOrigin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.ssoApiKey },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        token: decrypt(
          session.encrypted_refresh_token || session.encrypted_token,
          config.encryptionKey,
        ),
      }),
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}
