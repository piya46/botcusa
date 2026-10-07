#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

export function validateHostingEnvironment(env, nodeVersion = process.versions.node) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  const problems = [];
  if (major < 22 || (major === 22 && minor < 12)) problems.push('ต้องใช้ Node.js 22.12 ขึ้นไป');
  if (env.APP_MODE !== 'live') problems.push('APP_MODE ต้องเป็น live');
  try {
    const origin = new URL(env.APP_ORIGIN);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== env.APP_ORIGIN ||
      origin.hostname.endsWith('.invalid') ||
      origin.username ||
      origin.password
    )
      throw new Error();
  } catch {
    problems.push('APP_ORIGIN ต้องเป็น HTTPS origin ของโดเมนจริง ไม่มี / ท้าย URL');
  }
  try {
    if (
      !['mysql:', 'mariadb:', 'postgres:', 'postgresql:'].includes(
        new URL(env.DATABASE_URL).protocol,
      ) ||
      !new URL(env.DATABASE_URL).pathname.slice(1)
    )
      throw new Error();
  } catch {
    problems.push(
      'ระบุ DATABASE_URL ของ MySQL/MariaDB พร้อมชื่อฐานข้อมูล (หรือ PostgreSQL สำหรับโฮสต์เดิม)',
    );
  }
  if (env.WORKER_MODE && !['opportunistic', 'continuous'].includes(env.WORKER_MODE))
    problems.push('WORKER_MODE ต้องเป็น opportunistic หรือ continuous');
  if (Buffer.from(env.DATA_ENCRYPTION_KEY ?? '', 'base64').length !== 32)
    problems.push('DATA_ENCRYPTION_KEY ต้องเป็น base64 ของ 32 bytes');
  if ((env.ADMIN_PASSWORD ?? '').length < 12)
    problems.push('ADMIN_PASSWORD ต้องยาวอย่างน้อย 12 ตัว');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL ?? '')) problems.push('ระบุ ADMIN_EMAIL');
  return problems;
}

export function initializeHostingEnv(root) {
  const path = join(root, '.env');
  if (existsSync(path)) return false;
  const template = `# Plesk shared hosting — private file, never place inside public/\nAPP_MODE=live\nNODE_ENV=production\nHOST=127.0.0.1\nPORT=3001\nAPP_ORIGIN=https://your-domain.invalid\nDATA_DIR=.data\nDATABASE_URL=\nMYSQL_SSL_CA=\nWORKER_MODE=opportunistic\nDATA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nADMIN_EMAIL=\nADMIN_PASSWORD=${randomBytes(24).toString('base64url')}\nLINE_CHANNEL_SECRET=\nLINE_CHANNEL_ACCESS_TOKEN=\nLINE_LOGIN_CHANNEL_ID=\nLIFF_ID=\nLINE_MEMBER_RICH_MENU_ID=\nLINE_GUEST_RICH_MENU_ID=\nLINE_AGENT_ALERT_USER_ID=\nLINE_SUPERVISOR_ALERT_USER_ID=\nLINE_LOADING_ENABLED=true\nLINE_LOADING_SECONDS=30\nGEMINI_API_KEY=\nGEMINI_MODEL=\nGEMINI_EMBEDDING_MODEL=\nAI_ANALYTICS_ENABLED=false\nCUSA_SSO_ORIGIN=https://sso.reunion.scicu-alumni.com\nCUSA_CLIENT_ID=\nCUSA_API_KEY=\nCHAT_RETENTION_DAYS=180\nDATASET_RETENTION_DAYS=180\n`;
  writeFileSync(path, template, { mode: 0o600, flag: 'wx' });
  return true;
}

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  process.chdir(root);
  if (process.argv.includes('--help')) {
    console.log(
      'node install.mjs [--init | --check | --skip-build]\nFirst run creates a private .env. Fill APP_ORIGIN, DATABASE_URL and ADMIN_EMAIL, then run again.\nPlesk: Application Root=this directory, Document Root=public, Startup File=app.cjs.\nMySQL/MariaDB shared hosting: WORKER_MODE=opportunistic, no local cron required. See docs/PLESK-INSTALL.md and docs/ENVIRONMENT.md.',
    );
    return;
  }
  const created = initializeHostingEnv(root);
  if (created || process.argv.includes('--init')) {
    console.log(
      created
        ? 'สร้าง .env แล้ว (สิทธิ์ 600) พร้อม encryption key และรหัส admin แบบสุ่ม'
        : 'มี .env อยู่แล้ว ไม่เขียนทับ',
    );
    console.log(
      'แก้ APP_ORIGIN, DATABASE_URL และ ADMIN_EMAIL ใน Plesk File Manager แล้วรัน installer อีกครั้ง รหัส admin อยู่ในไฟล์ .env',
    );
    return;
  }
  const env = { ...parseEnv(readFileSync(join(root, '.env'), 'utf8')), ...process.env };
  const problems = validateHostingEnvironment(env);
  if (problems.length) throw new Error(problems.join('\n'));
  chmodSync(join(root, '.env'), 0o600);
  if (process.argv.includes('--check')) {
    console.log('ผ่านการตรวจ Node.js และรูปแบบการตั้งค่า (ยังไม่ทดสอบฐานข้อมูล)');
    return;
  }
  const npmCli = process.env.npm_execpath;
  const npm = (args) => {
    const result = npmCli
      ? spawnSync(process.execPath, [npmCli, ...args], {
          stdio: 'inherit',
          env: { ...env, NODE_ENV: 'development' },
        })
      : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          stdio: 'inherit',
          env: { ...env, NODE_ENV: 'development' },
        });
    if (result.error || result.status !== 0)
      throw new Error('คำสั่ง npm ไม่สำเร็จ กรุณาตรวจ log ด้านบน');
  };
  npm(['ci', '--include=dev', '--no-audit', '--no-fund']);
  if (!process.argv.includes('--skip-build')) npm(['run', 'build']);
  if (
    !existsSync(join(root, 'dist/index.html')) ||
    !existsSync(join(root, 'dist-server/server/index.js'))
  )
    throw new Error('ไม่พบไฟล์ build; รัน npm run build ก่อน');
  // Bootstrap is explicit; never bind HTTP, send LINE or start the worker during installation.
  Object.assign(process.env, env);
  const { getConfig } = await import('./dist-server/server/config.js');
  const { openDatabase } = await import('./dist-server/server/db.js');
  const { seed } = await import('./dist-server/server/seed.js');
  let db;
  try {
    const config = getConfig();
    db = await openDatabase(config);
    await seed(db, config);
  } catch (error) {
    const hints = {
      ER_ACCESS_DENIED_ERROR: 'ตรวจชื่อผู้ใช้และรหัสฐานข้อมูล',
      ER_BAD_DB_ERROR: 'สร้างฐานข้อมูลใน Plesk ก่อน',
      ECONNREFUSED: 'ตรวจ host/port ฐานข้อมูล',
      ER_TABLEACCESS_DENIED_ERROR: 'ตรวจสิทธิ์ CREATE/ALTER/INDEX ของผู้ใช้ฐานข้อมูล',
    };
    throw new Error(
      hints[error.code] ??
        (/^Requires MySQL/.test(error.message)
          ? error.message
          : 'เชื่อมต่อหรือสร้างตารางไม่สำเร็จ ตรวจ DATABASE_URL และสิทธิ์ฐานข้อมูล ดู docs/ENVIRONMENT.md'),
    );
  } finally {
    await db?.close();
  }
  mkdirSync(join(root, 'public'), { recursive: true });
  console.log(
    'ติดตั้งสำเร็จ: ตั้ง Document Root เป็น public และ Startup File เป็น app.cjs แล้ว Restart App ใน Plesk',
  );
  console.log(
    'Shared hosting: ตั้ง WORKER_MODE=opportunistic ไม่ต้องใช้ Scheduled Task; งานตั้งเวลารอจนแอปตื่นเมื่อโฮสต์พัก (ดู docs/PLESK-INSTALL.md)',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
