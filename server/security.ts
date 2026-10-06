import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decrypt(value: string | null, key: Buffer): string {
  if (!value) return '';
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function validLineSignature(body: Buffer, signature: string, secret: string): boolean {
  if (!secret || !signature) return false;
  const actual = createHmac('sha256', secret).update(body).digest();
  const supplied = Buffer.from(signature, 'base64');
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}
// Defense in depth: automated masking is followed by a human dataset review.
export function redact(text: string, identifiers: string[] = []): string {
  let result = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, '[SENSITIVE_NUMBER]')
    .replace(/(?<!\d)(?:(?:\+66|0066|0)[ -]?(?:\d[ -]?){8,9})(?!\d)/g, '[PHONE]')
    .replace(/\bU[0-9a-f]{32}\b/gi, '[LINE_USER]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[IDENTIFIER]');
  for (const identifier of identifiers
    .filter((v) => v.trim().length >= 2)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(identifier).join('[PERSON]');
  }
  return result;
}
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
