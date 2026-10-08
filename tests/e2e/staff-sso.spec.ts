import { test, expect } from '@playwright/test';

test.skip(!process.env.SSO_UI_TEST, 'Requires isolated synthetic SSO UI fixture');

test('staff login offers CUSA SSO without local email or password fields', async ({ page }) => {
  await page.route('**/api/auth/sso/start', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ returnTo: '/admin?reauth=1' });
    await route.fulfill({ json: { url: '/synthetic-sso' } });
  });
  await page.route('**/synthetic-sso', (route) =>
    route.fulfill({ body: 'Synthetic provider navigation' }),
  );
  await page.goto('/admin?reauth=1');
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบด้วย CUSA SSO' })).toBeVisible();
  await expect(page.locator('input[type=password],input[type=email]')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/staff-sso-login.png', fullPage: true });
  await page.getByRole('button', { name: 'เข้าสู่ระบบด้วย CUSA SSO' }).click();
  await expect(page).toHaveURL(/synthetic-sso$/);
});

test('expired authorization preserves an unsent reply while the same staff member signs in again', async ({
  page,
}) => {
  let expired = false;
  await page.route('**/api/**', async (route) => {
    if (expired && !new URL(route.request().url()).pathname.startsWith('/api/auth/'))
      await route.fulfill({ status: 401, json: { error: 'เซสชันหมดอายุ' } });
    else await route.continue();
  });
  await page.goto('/admin/inbox');
  await expect(page.locator('.conversation-item').first()).toBeVisible();
  const cases = await page.evaluate(async () => (await fetch('/api/conversations')).json());
  const assigned = cases.find(
    (c: { status: string; assigned_agent_id: string }) =>
      c.status === 'AGENT_IN_CHARGE' &&
      c.assigned_agent_id === '11111111-1111-4111-8111-111111111111',
  );
  expect(assigned).toBeTruthy();
  await page.goto(`/admin/inbox?case=${assigned.id}`);
  const reply = page.getByRole('textbox', { name: 'ข้อความตอบสมาชิก' });
  await reply.fill('ข้อความร่างที่ต้องอยู่หลังยืนยันตัวตนใหม่');
  expired = true;
  await expect(page.getByRole('dialog')).toContainText('ยืนยันตัวตนเพื่อทำงานต่อ');
  await expect(page.getByRole('link', { name: 'เปิด CUSA SSO' })).toHaveAttribute(
    'target',
    '_blank',
  );
  expired = false;
  await page.getByRole('button', { name: 'ยืนยันตัวตนแล้ว', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(reply).toHaveValue('ข้อความร่างที่ต้องอยู่หลังยืนยันตัวตนใหม่');
});
