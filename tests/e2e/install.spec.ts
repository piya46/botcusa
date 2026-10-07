import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Explicit disposable fixture only. Never run against a deployed /install page.
test('first-run wizard creates private configuration and SSO settings on MariaDB, then closes setup', async ({
  page,
  request,
}) => {
  test.skip(
    !process.env.INSTALL_TEST_FIXTURE,
    'Requires an isolated installer and empty test database',
  );
  test.setTimeout(60000);
  const fixture = JSON.parse(await readFile(process.env.INSTALL_TEST_FIXTURE!, 'utf8'));
  expect(fixture.root).toMatch(/^\/.*\/cusa-install-web-/);
  expect(fixture.name).toMatch(/^cusa_install_\d+$/);
  const key = await readFile(`${fixture.root}/.setup/access.key`, 'utf8');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/install');
  await expect(page.getByRole('heading', { name: 'เริ่มจากรหัสติดตั้ง' })).toBeVisible();
  await page.getByLabel('รหัสติดตั้ง', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'เริ่มตั้งค่า' }).click();
  await page.getByLabel('URL ของเว็บ', { exact: false }).fill('https://bot.example.org');
  await expect(page.getByLabel('อีเมลผู้ดูแล', { exact: true })).toHaveCount(0);
  await page
    .getByLabel('Application UUID', { exact: false })
    .fill('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  await page.getByLabel('Backend API key', { exact: false }).fill('synthetic-sso-key');
  await expect(page.getByText('admin', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/install-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'ถัดไป' }).click();
  await page.getByLabel('Database host', { exact: false }).fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill('33079');
  await page.getByLabel('ชื่อฐานข้อมูล', { exact: false }).fill(fixture.name);
  await page.getByLabel('ชื่อผู้ใช้ฐานข้อมูล', { exact: true }).fill('cusa_install_test');
  await page.getByLabel('รหัสผ่านฐานข้อมูล', { exact: false }).fill('InstallTest@123#');
  await page.getByRole('button', { name: 'ทดสอบฐานข้อมูล' }).click();
  await expect(page.getByRole('status')).toContainText('เชื่อมต่อได้');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/install-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'ถัดไป' }).click();
  await page.locator('summary').filter({ hasText: 'LINE Messaging API' }).click();
  await expect(page.getByLabel('Channel secret', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'ตรวจและติดตั้ง' }).click();
  await page.getByLabel('ตรวจค่าครบแล้ว และใช้ฐานข้อมูลสำหรับระบบใหม่นี้').check();
  await page.getByRole('button', { name: 'ติดตั้งระบบ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ติดตั้งสำเร็จ' })).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({ path: 'artifacts/install-success-mobile.png', fullPage: true });
  const env = parseEnv(await readFile(`${fixture.root}/.env`, 'utf8'));
  expect(env.ADMIN_EMAIL).toBeUndefined();
  expect(env.CUSA_CLIENT_ID).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  expect(decodeURIComponent(new URL(env.DATABASE_URL!).password)).toBe('InstallTest@123#');
  expect(existsSync(`${fixture.root}/.setup/access.key`)).toBe(false);
  const again = await request.post('/api/install/apply', {
    headers: { authorization: 'Bearer ' + key },
    data: {},
  });
  expect(again.status()).toBe(409);
  expect(errors).toEqual([]);
});
