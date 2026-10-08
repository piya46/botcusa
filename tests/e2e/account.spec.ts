import { test, expect } from '@playwright/test';
import type { StaffAccount } from '../../shared/types';

const account = (sameProvider: boolean): StaffAccount => ({
  agent: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'เจ้าหน้าที่ทดสอบ',
    email: 'staff@example.org',
    role: 'ADMIN',
  },
  demo: false,
  line: {
    userId: 'U' + 'a'.repeat(32),
    source: sameProvider ? 'SSO' : 'OA_LINK',
    verified: true,
    enabled: true,
  },
  lineManagedBySso: sameProvider,
  canLinkLine: !sameProvider,
});

test('same Provider shows SSO-managed LINE without self-service replace or unlink', async ({
  page,
}) => {
  const data = account(true);
  await page.route('**/api/account', (route) => route.fulfill({ json: data }));
  await page.goto('/admin/account');
  await expect(page.getByText('ผูกผ่าน SSO แล้ว', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ผูก LINE ใหม่', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ยกเลิกการผูก LINE', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'รับแจ้งเตือนเคส', exact: true })).toBeChecked();
  await page.screenshot({
    path: 'artifacts/account-sso-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto('/connect/staff');
  await expect(page.getByText('ผูกผ่าน SSO แล้ว', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ตรวจสอบ LINE ของฉัน', exact: true })).toHaveCount(
    0,
  );
});

test('different Provider account offers relink and confirms unlink on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let data = account(false),
    removals = 0;
  await page.route('**/api/account', (route) => route.fulfill({ json: data }));
  await page.route('**/api/account/line', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().postDataJSON()).toEqual({
      accountId: data.agent.id,
      expectedCurrentUserId: data.line.userId,
    });
    removals++;
    data = { ...data, line: { userId: null, source: null, verified: false, enabled: false } };
    await route.fulfill({ json: data });
  });
  await page.goto('/admin/account');
  await expect(page.getByRole('link', { name: 'ผูก LINE ใหม่', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ผูก LINE ใหม่', exact: true })).toHaveAttribute(
    'href',
    '/connect/staff',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'artifacts/account-line-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'ยกเลิกการผูก LINE', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('คุณยังใช้งาน Member Desk ตามสิทธิ์เดิมได้');
  expect(removals).toBe(0);
  await page.getByRole('button', { name: 'กลับ', exact: true }).click();
  expect(removals).toBe(0);
  await page.getByRole('button', { name: 'ยกเลิกการผูก LINE', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันยกเลิก', exact: true }).click();
  await expect(page.getByText('ยังไม่ผูก LINE', { exact: true })).toBeVisible();
  expect(removals).toBe(1);
});

test('different Provider previews LINE and only binds after explicit confirmation', async ({
  page,
}) => {
  const data = account(false);
  let confirmations = 0;
  await page.route('**/api/account', (route) => route.fulfill({ json: data }));
  await page.route('**/api/connect/config', (route) =>
    route.fulfill({ json: { liffId: 'synthetic-liff', available: true, demo: false } }),
  );
  // Replace the SDK module only in the browser test. Never contact LINE.
  await page.route(
    /\/(?:assets\/liff-[^/]+\.js|node_modules\/\.vite\/deps\/@line_liff\.js)(?:\?.*)?$/,
    (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `export default {init:async()=>{},isLoggedIn:()=>true,getIDToken:()=> 'synthetic-line-id-token',getDecodedIDToken:()=>({sub:'U${'b'.repeat(32)}',name:'LINE ทดสอบ'})};`,
      }),
  );
  await page.route('**/api/account/line', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({
      source: 'OA_LINK',
      accountId: data.agent.id,
      expectedCurrentUserId: data.line.userId,
      lineIdToken: 'synthetic-line-id-token',
    });
    confirmations++;
    await route.fulfill({
      json: { ...data, line: { ...data.line, userId: 'U' + 'b'.repeat(32) } },
    });
  });
  await page.goto('/admin/account');
  await expect(page.getByRole('link', { name: 'ผูก LINE ใหม่', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'ผูก LINE ใหม่', exact: true }).click();
  await page.getByRole('button', { name: 'ตรวจสอบ LINE ของฉัน', exact: true }).click();
  await expect(page.getByText('LINE ทดสอบ', { exact: true })).toBeVisible();
  expect(confirmations).toBe(0);
  await page.getByRole('button', { name: 'ยังไม่ผูก', exact: true }).click();
  expect(confirmations).toBe(0);
  await page.getByRole('button', { name: 'ตรวจสอบ LINE ของฉัน', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ใช่ ผูก LINE นี้', exact: true })).toBeVisible();
  await page.screenshot({
    path: 'artifacts/account-line-confirm.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'ใช่ ผูก LINE นี้', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ผูก LINE แล้ว', exact: true })).toBeVisible();
  expect(confirmations).toBe(1);
});
