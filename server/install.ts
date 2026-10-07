import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import mysql from 'mysql2/promise';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseEnv } from 'node:util';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { installGroups } from '../shared/install.js';
import { AppError } from './security.js';
import { assertMysqlVersion, mysqlConnectionOptions } from './mysql.js';
import { openDatabase } from './db.js';
import { getConfig } from './config.js';
import { seed } from './seed.js';

const setupDir = (root: string) => join(root, '.setup');
const completed = (root: string) => existsSync(join(setupDir(root), 'completed'));
const configured = (env: NodeJS.ProcessEnv) =>
  Boolean(
    env.APP_MODE === 'live' &&
    env.DATABASE_URL &&
    env.DATA_ENCRYPTION_KEY &&
    env.CUSA_SSO_ORIGIN &&
    env.CUSA_CLIENT_ID &&
    env.CUSA_API_KEY &&
    env.APP_ORIGIN?.startsWith('https://') &&
    !env.APP_ORIGIN.includes('.invalid'),
  );
export function needsWebInstall(root: string, env: NodeJS.ProcessEnv) {
  if (completed(root)) return false;
  if (existsSync(join(setupDir(root), 'pending.json'))) return true;
  return (env.APP_MODE === 'live' || env.CUSA_PLESK_STARTUP === '1') && !configured(env);
}
export function prepareWebInstall(root: string) {
  if (completed(root)) throw new AppError(409, 'ระบบนี้ติดตั้งแล้ว');
  mkdirSync(setupDir(root), { recursive: true, mode: 0o700 });
  const path = join(setupDir(root), 'access.key');
  try {
    writeFileSync(path, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
const plain = z
  .string()
  .max(8000)
  .refine((v) => !/[\r\n\0]/.test(v), 'ใช้ค่าในบรรทัดเดียว');
const serviceKeys = new Set([
  ...installGroups.flatMap((g) => g.fields.map((f) => f.key)),
  'CUSA_SSO_ORIGIN',
  'CUSA_CLIENT_ID',
  'CUSA_API_KEY',
]);
const inputSchema = z
  .object({
    origin: z
      .string()
      .url()
      .max(500)
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === 'https:' &&
          u.origin === v &&
          !u.hostname.endsWith('.invalid') &&
          !u.username &&
          !u.password
        );
      }, 'ใช้ HTTPS origin ไม่มี / ท้าย URL'),
    database: z
      .object({
        host: z
          .string()
          .trim()
          .min(1)
          .max(253)
          .regex(/^[a-zA-Z0-9.:-]+$/),
        port: z.number().int().min(1).max(65535),
        name: plain.pipe(z.string().min(1).max(64)),
        user: plain.pipe(z.string().min(1).max(128)),
        password: plain.pipe(z.string().min(1)),
        tls: z.boolean(),
        caFile: plain.default(''),
      })
      .strict(),
    services: z
      .record(
        z.string().refine((key) => serviceKeys.has(key)),
        plain,
      )
      .default({}),
  })
  .strict();

export function dotenvText(env: Record<string, string>) {
  return (
    '# CUSA Member Desk — private configuration\n' +
    Object.entries(env)
      .map(([key, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value))
          throw new AppError(400, 'รูปแบบการตั้งค่าไม่ถูกต้อง');
        // Both loaders must round-trip literal backslashes, quotes and # unchanged.
        const line = ["'", '`', '"']
          .filter((q) => !value.includes(q))
          .map((q) => `${key}=${q}${value}${q}`)
          .find((text) => parseEnv(text)[key] === value && parseDotenv(text)[key] === value);
        if (!line) throw new AppError(400, `${key}: ไม่สามารถบันทึกค่านี้ได้`);
        return line;
      })
      .join('\n') +
    '\n'
  );
}
function readEnv(root: string) {
  const path = join(root, '.env');
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}
function candidateEnv(root: string, value: unknown, inherited: NodeJS.ProcessEnv) {
  const body = inputSchema.parse(value),
    prior = readEnv(root),
    d = body.database;
  const host = d.host.includes(':') && !d.host.startsWith('[') ? `[${d.host}]` : d.host;
  const url = `mysql://${encodeURIComponent(d.user)}:${encodeURIComponent(d.password)}@${host}:${d.port}/${encodeURIComponent(d.name)}${d.tls ? '?ssl=true' : ''}`;
  mysqlConnectionOptions(url, (d.tls && d.caFile) || undefined);
  const dataDir = resolve(root, prior.DATA_DIR || '.data');
  if (dataDir === resolve(root, 'public') || dataDir.startsWith(resolve(root, 'public') + '/'))
    throw new AppError(400, 'DATA_DIR ต้องอยู่นอก public');
  let key = prior.DATA_ENCRYPTION_KEY;
  if (!key && existsSync(join(dataDir, 'encryption.key')))
    key = readFileSync(join(dataDir, 'encryption.key')).toString('base64');
  key ||= randomBytes(32).toString('base64');
  if (Buffer.from(key, 'base64').length !== 32)
    throw new AppError(400, 'encryption key เดิมไม่ถูกต้อง กรุณาตรวจไฟล์ .env');
  const env: Record<string, string> = {
    ...prior,
    APP_MODE: 'live',
    NODE_ENV: 'production',
    HOST: prior.HOST || '127.0.0.1',
    PORT: prior.PORT || '3001',
    APP_ORIGIN: body.origin,
    DATABASE_URL: url,
    MYSQL_SSL_CA: d.tls ? d.caFile : '',
    DATA_DIR: prior.DATA_DIR || '.data',
    WORKER_MODE: 'opportunistic',
    DATA_ENCRYPTION_KEY: key,
    LINE_LOADING_ENABLED: 'true',
    LINE_LOADING_SECONDS: '30',
    AI_ANALYTICS_ENABLED: 'false',
    CHAT_RETENTION_DAYS: '180',
    DATASET_RETENTION_DAYS: '180',
  };
  for (const name of serviceKeys) env[name] = body.services[name] || prior[name] || env[name] || '';
  delete env.ADMIN_EMAIL;
  delete env.ADMIN_PASSWORD;
  const ssoOrigin = z.url().safeParse(env.CUSA_SSO_ORIGIN);
  if (
    !ssoOrigin.success ||
    new URL(ssoOrigin.data).protocol !== 'https:' ||
    new URL(ssoOrigin.data).origin !== ssoOrigin.data
  )
    throw new AppError(400, 'CUSA_SSO_ORIGIN ต้องเป็น HTTPS origin ไม่มี path');
  if (!z.string().uuid().safeParse(env.CUSA_CLIENT_ID).success || !env.CUSA_API_KEY.trim())
    throw new AppError(400, 'ระบุ Application UUID และ Backend API key ของ CUSA SSO');
  for (const [name, val] of Object.entries(env))
    if (
      !['HOST', 'PORT', 'NODE_ENV'].includes(name) &&
      inherited[name] !== undefined &&
      inherited[name] !== prior[name] &&
      inherited[name] !== val
    )
      throw new AppError(
        409,
        `มี ${name} ใน Plesk Environment Variables ที่จะทับค่าใน .env กรุณาแก้ให้ตรงกันหรือนำค่าซ้ำออกก่อน`,
      );
  for (const name of ['LINE_LOADING_ENABLED', 'AI_ANALYTICS_ENABLED'])
    if (!['true', 'false'].includes(env[name]))
      throw new AppError(400, `${name} ต้องเป็น true หรือ false`);
  for (const name of ['CHAT_RETENTION_DAYS', 'DATASET_RETENTION_DAYS'])
    if (!/^\d+$/.test(env[name]) || +env[name] < 1 || +env[name] > 3650)
      throw new AppError(400, `${name} ต้องเป็น 1–3650 วัน`);
  const seconds = +env.LINE_LOADING_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60 || seconds % 5 !== 0)
    throw new AppError(400, 'Loading ต้องเป็น 5–60 วินาที เพิ่มทีละ 5');
  for (const name of ['LINE_AGENT_ALERT_USER_ID', 'LINE_SUPERVISOR_ALERT_USER_ID'])
    if (env[name] && !/^U[0-9a-f]{32}$/.test(env[name]))
      throw new AppError(400, `${name} ต้องเป็น LINE User ID`);
  if (env.AI_ANALYTICS_ENABLED === 'true' && (!env.GEMINI_API_KEY || !env.GEMINI_MODEL))
    throw new AppError(400, 'การวิเคราะห์ต้องมี Gemini key และ model');
  return env;
}
type DatabaseInspection = { version: string; tables: number };
export interface InstallDatabase {
  inspect(env: Record<string, string>): Promise<DatabaseInspection>;
  bootstrap(env: Record<string, string>, root: string): Promise<void>;
}
const defaultDatabase: InstallDatabase = {
  async inspect(env) {
    const db = await mysql.createConnection(
      mysqlConnectionOptions(env.DATABASE_URL, env.MYSQL_SSL_CA || undefined),
    );
    try {
      const [rows] = await db.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
      assertMysqlVersion(String(rows[0].version));
      const [tables] = await db.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema=DATABASE()',
      );
      return { version: String(rows[0].version), tables: Number(tables[0].total) };
    } finally {
      await db.end();
    }
  },
  async bootstrap(env, root) {
    const config = getConfig({ ...env, DATA_DIR: resolve(root, env.DATA_DIR) });
    const db = await openDatabase(config);
    try {
      await seed(db, config);
    } finally {
      await db.close();
    }
  },
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (env: Record<string, string>) =>
  digest(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))));
async function resumable(root: string, hash: string) {
  try {
    return (
      JSON.parse(await readFile(join(setupDir(root), 'pending.json'), 'utf8')).fingerprint === hash
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function buildInstallApp(options: {
  root: string;
  database?: InstallDatabase;
  serveStatic?: boolean;
  environment?: NodeJS.ProcessEnv;
}) {
  const root = resolve(options.root),
    database = options.database ?? defaultDatabase;
  prepareWebInstall(root);
  // Persist a key once even when bootstrapping without a CLI-generated .env, so retries reuse it.
  const privateKey = join(setupDir(root), 'encryption.key');
  if (!existsSync(privateKey)) {
    try {
      writeFileSync(privateKey, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });
  await app.register(rateLimit, { max: 30, timeWindow: '1 minute' });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    const hints: Record<string, string> = {
      ER_ACCESS_DENIED_ERROR: 'ชื่อผู้ใช้หรือรหัสฐานข้อมูลไม่ถูกต้อง',
      ER_BAD_DB_ERROR: 'ไม่พบฐานข้อมูล กรุณาสร้างผ่าน Plesk ก่อน',
      ECONNREFUSED: 'เชื่อมต่อฐานข้อมูลไม่ได้ ตรวจ host และ port',
      ENOTFOUND: 'ไม่พบ host ฐานข้อมูล',
      ER_TABLEACCESS_DENIED_ERROR: 'สิทธิ์ฐานข้อมูลไม่พอ ตรวจ CREATE / ALTER / INDEX',
    };
    const message =
      e instanceof AppError
        ? e.message
        : e instanceof z.ZodError
          ? 'ข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้อง ตรวจช่องที่กรอก'
          : (hints[e.code ?? ''] ??
            (/^Requires MySQL/.test(e.message)
              ? e.message
              : 'ติดตั้งไม่สำเร็จ ตรวจฐานข้อมูล สิทธิ์เขียนไฟล์ และการตั้งค่า'));
    reply.code(e instanceof z.ZodError ? 400 : (e.statusCode ?? 400)).send({ error: message });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY');
    if (request.method !== 'POST' || !request.url.startsWith('/api/install/')) return;
    if (completed(root)) throw new AppError(409, 'ติดตั้งสำเร็จแล้ว กรุณา Restart App');
    let origin: URL;
    try {
      origin = new URL(request.headers.origin ?? '');
    } catch {
      throw new AppError(403, 'ที่มาของคำขอไม่ถูกต้อง');
    }
    const peer = request.ip;
    const local =
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (!local && (origin.protocol !== 'https:' || origin.host !== request.headers.host))
      throw new AppError(403, 'เปิดหน้าติดตั้งผ่าน HTTPS ของโดเมนนี้');
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const expected = readFileSync(join(setupDir(root), 'access.key'), 'utf8').trim();
    if (!supplied || !timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(expected))))
      throw new AppError(401, 'รหัสติดตั้งไม่ถูกต้อง');
  });
  app.get('/api/install/status', async () => ({
    installed: completed(root),
    restartRequired: completed(root),
  }));
  app.get('/', async (_request, reply) => reply.redirect('/install'));
  app.get('/api/health', async (_request, reply) =>
    reply.code(503).send({ ok: false, setupRequired: true }),
  );
  app.post('/api/install/unlock', async () => {
    const existing = readEnv(root);
    return {
      origin: existing.APP_ORIGIN?.includes('.invalid') ? '' : existing.APP_ORIGIN || '',
    };
  });
  const candidate = (body: unknown) => {
    // A generated installer key never replaces an existing .env or local data key.
    const env = candidateEnv(root, body, options.environment ?? process.env);
    if (
      !readEnv(root).DATA_ENCRYPTION_KEY &&
      !existsSync(resolve(root, env.DATA_DIR, 'encryption.key'))
    )
      env.DATA_ENCRYPTION_KEY = readFileSync(privateKey).toString('base64');
    return env;
  };
  app.post('/api/install/check', async (request) => {
    const env = candidate(request.body);
    dotenvText(env);
    const result = await database.inspect(env);
    const resume = await resumable(root, fingerprint(env));
    if (result.tables && !resume)
      throw new AppError(
        409,
        'ฐานข้อมูลนี้มีตารางอยู่แล้ว กรุณาเลือกฐานข้อมูลเปล่าสำหรับติดตั้งใหม่',
      );
    return { ...result, resumable: resume };
  });
  app.post('/api/install/apply', async (request) => {
    const lockPath = join(setupDir(root), 'apply.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AppError(409, 'มีการติดตั้งกำลังทำงานอยู่');
      throw error;
    }
    let temporary: string | undefined;
    try {
      if (completed(root)) throw new AppError(409, 'ระบบนี้ติดตั้งแล้ว');
      const original = existsSync(join(root, '.env'))
        ? await readFile(join(root, '.env'), 'utf8')
        : null;
      const env = candidate(request.body),
        hash = fingerprint(env),
        text = dotenvText(env);
      const inspection = await database.inspect(env);
      if (inspection.tables && !(await resumable(root, hash)))
        throw new AppError(
          409,
          'ฐานข้อมูลนี้มีข้อมูลอยู่แล้ว หรือค่าที่กรอกไม่ตรงกับการติดตั้งค้างครั้งก่อน',
        );
      await writeFile(join(setupDir(root), 'pending.json'), JSON.stringify({ fingerprint: hash }), {
        mode: 0o600,
      });
      await database.bootstrap(env, root);
      const current = existsSync(join(root, '.env'))
        ? await readFile(join(root, '.env'), 'utf8')
        : null;
      if (current !== original)
        throw new AppError(409, 'ไฟล์ .env ถูกแก้ระหว่างติดตั้ง กรุณาตรวจไฟล์ก่อนลองอีกครั้ง');
      if (original !== null && !existsSync(join(setupDir(root), 'previous.env')))
        await writeFile(join(setupDir(root), 'previous.env'), original, {
          mode: 0o600,
          flag: 'wx',
        });
      temporary = join(root, `.env.install-${randomUUID()}`);
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(root, '.env'));
      temporary = undefined;
      await writeFile(join(setupDir(root), 'completed'), new Date().toISOString(), { mode: 0o600 });
      await unlink(join(setupDir(root), 'access.key')).catch(() => {});
      await unlink(join(setupDir(root), 'pending.json')).catch(() => {});
      return { installed: true, restartRequired: true, origin: env.APP_ORIGIN };
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(lockPath).catch(() => {});
    }
  });
  if (options.serveStatic && existsSync(join(root, 'dist/index.html'))) {
    await app.register(staticFiles, { root: join(root, 'dist'), prefix: '/' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'ไม่พบ API' })
        : request.url.split('?')[0] === '/install'
          ? reply.sendFile('index.html')
          : reply.redirect('/install'),
    );
  }
  return app;
}
