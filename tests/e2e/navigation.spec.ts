import { test, expect } from '@playwright/test';
import { waitForWorkspace } from './support';

test.beforeEach(async ({ request }, info) => {
  await waitForWorkspace(request, info);
});

test('grouped navigation, shortcuts and settings tabs keep every workspace function reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/admin/overview');
  await expect(page.getByRole('heading', { name: 'ภาพรวมวันนี้' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toContainText('ความรู้และ AI');
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('ค้นหาทั้งระบบ')).toBeFocused();
  await page.screenshot({
    path: 'artifacts/yellow-overview-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'จัดการเคส', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'เคสและการส่งต่อ', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'เคสและการส่งต่อ', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'แจ้งเตือนเคสผ่าน LINE' })).toBeVisible();
  await page.getByRole('button', { name: 'AI และข้อมูล', exact: true }).click();
  await expect(page.getByLabel('System prompt')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกการตั้งค่า', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ประวัติระบบ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'บันทึกการดำเนินการ' })).toBeVisible();
  await expect(page.getByLabel('System prompt')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    'overview',
    'knowledge',
    'training',
    'members',
    'broadcasts',
    'insights',
    'settings',
  ]) {
    await page.goto(`/admin/${route}`);
    await expect(page.locator('main h1')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      route,
    ).toBe(true);
    if (route === 'overview' || route === 'settings')
      await page.screenshot({
        path: `artifacts/yellow-${route}-mobile.png`,
        fullPage: true,
        animations: 'disabled',
      });
  }
  await page.getByRole('button', { name: 'เปิดเมนู', exact: true }).click();
  await expect(page.getByRole('link', { name: 'ฐานความรู้', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'ฐานความรู้', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ฐานความรู้', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await page.getByRole('button', { name: /การแจ้งเตือนเคส/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const modal = await page.getByRole('dialog').boundingBox();
  expect(modal!.x).toBeGreaterThanOrEqual(0);
  expect(modal!.y).toBeGreaterThanOrEqual(0);
  expect(modal!.x + modal!.width).toBeLessThanOrEqual(390);
  expect(modal!.y + modal!.height).toBeLessThanOrEqual(844);
  await page.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
  expect(errors).toEqual([]);
});
