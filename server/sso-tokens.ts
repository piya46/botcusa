import { z } from 'zod';
import type { Config } from './config.js';
import type { Fetcher } from './providers.js';
import { AppError } from './security.js';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const tokenSchema = z
  .object({
    access_token: opaque,
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().max(300),
    scope: z.string(),
    refresh_token: opaque.optional(),
    refresh_expires_in: z.number().int().positive().optional(),
  })
  .refine((v) => (v.refresh_token === undefined) === (v.refresh_expires_in === undefined));

// Exactly one provider request. A lost response can mean the one-use credential was consumed.
export async function requestCusaToken(
  config: Config,
  body: Record<string, string | boolean>,
  fetcher: Fetcher,
) {
  const origin = new URL(config.ssoOrigin);
  if (origin.protocol !== 'https:') throw new AppError(503, 'SSO ต้องใช้ HTTPS');
  const startedAt = Date.now();
  const response = await fetcher(new URL('/api/sso/token', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': config.ssoApiKey },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new AppError(401, 'SSO ไม่สามารถต่ออายุหรือแลกรหัสได้ กรุณาเข้าสู่ระบบใหม่');
  const parsed = tokenSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.scope.split(' ').includes('identity:read'))
    throw new AppError(401, 'ข้อมูล token ของ SSO ไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
  const token = parsed.data;
  return {
    accessToken: token.access_token,
    expiresAt: startedAt + token.expires_in * 1000,
    scope: token.scope,
    refreshToken: token.refresh_token,
    refreshExpiresAt:
      token.refresh_expires_in === undefined
        ? undefined
        : startedAt + token.refresh_expires_in * 1000,
  };
}
