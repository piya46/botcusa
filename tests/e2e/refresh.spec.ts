import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('automatic refresh keeps the workspace and draft open; removed roles still require reauthentication', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  test.skip(!process.env.REFRESH_UI_FIXTURE, 'Requires the isolated refresh browser fixture');
  const fixture = JSON.parse(await readFile(process.env.REFRESH_UI_FIXTURE!, 'utf8'));
  // Test-only local session over loopback. Real SSO cookies are Secure and created via PKCE callback.
  await context.addCookies([
    {
      name: 'cusa_session',
      value: fixture.cookie,
      url: baseURL!,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/admin/inbox?case=${fixture.caseId}`);
  const draft = page.getByRole('textbox', { name: 'ข้อความตอบสมาชิก' });
  await draft.fill('ข้อความร่างที่ต้องอยู่ระหว่างต่ออายุอัตโนมัติ');
  const expired = await request.post('/test/expire-access', {
    headers: { origin: 'https://desk.example.org' },
  });
  expect(expired.ok()).toBe(true);
  await expect
    .poll(async () => (await (await request.get('/test/status')).json()).rotations)
    .toBe(1);
  await expect(draft).toHaveValue('ข้อความร่างที่ต้องอยู่ระหว่างต่ออายุอัตโนมัติ');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/admin/inbox\\?case=${fixture.caseId}`));
  const removed = await request.post('/test/remove-role', {
    headers: { origin: 'https://desk.example.org' },
  });
  expect(removed.ok()).toBe(true);
  await expect(page.getByRole('dialog')).toContainText('ยืนยันตัวตนเพื่อทำงานต่อ');
  expect((await (await request.get('/test/status')).json()).rotations).toBe(1);
  expect(errors).toEqual([]);
});
