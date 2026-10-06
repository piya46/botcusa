import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config } from './config.js';
import { AppError, encrypt, decrypt } from './security.js';

export function imageType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  return null;
}
export async function storeFile(config: Config, id: string, bytes: Buffer) {
  const dir = resolve(config.dataDir, 'attachments');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(dir, id), encrypt(bytes.toString('base64'), config.encryptionKey), {
    mode: 0o600,
  });
  return id;
}
export async function readFileContent(config: Config, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError(400, 'รหัสไฟล์ไม่ถูกต้อง');
  return Buffer.from(
    decrypt(
      await readFile(resolve(config.dataDir, 'attachments', id), 'utf8'),
      config.encryptionKey,
    ),
    'base64',
  );
}
export async function deleteFile(config: Config, id: string) {
  if (/^[0-9a-f-]{36}$/.test(id))
    await unlink(resolve(config.dataDir, 'attachments', id)).catch(() => {});
}
export function mediaSignature(config: Config, id: string, expires: number) {
  return createHmac('sha256', config.encryptionKey).update(`media:${id}:${expires}`).digest('hex');
}
export function mediaUrl(config: Config, id: string) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return `${config.origin}/api/media/${id}?expires=${expires}&signature=${mediaSignature(config, id, expires)}`;
}
export function verifyMedia(config: Config, id: string, expires: number, signature: string) {
  const now = Date.now() / 1000;
  if (
    !Number.isFinite(expires) ||
    expires < now ||
    expires > now + 3605 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(mediaSignature(config, id, expires), 'hex'),
  );
}
