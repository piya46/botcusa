import { test, expect } from '@playwright/test';

test('response example setting persists and reviewers can retire a previously approved example', async ({
  page,
}) => {
  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'AI และข้อมูล', exact: true }).click();
  const useExamples = page.getByRole('checkbox', { name: /ใช้ตัวอย่างวิธีตอบที่อนุมัติ/ });
  await expect(useExamples).toBeChecked();
  await useExamples.uncheck();
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า', exact: true }).click();
  await expect(page.getByText('บันทึกการตั้งค่าแล้ว', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'AI และข้อมูล', exact: true }).click();
  await expect(useExamples).not.toBeChecked();
  await useExamples.check();
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า', exact: true }).click();
  await expect(page.getByText('บันทึกการตั้งค่าแล้ว', { exact: true })).toBeVisible();
  await page.screenshot({
    path: 'artifacts/ai-teaching-settings.png',
    fullPage: true,
    animations: 'disabled',
  });

  const response = await page.request.get('/api/training');
  const example = (await response.json()).find((e: any) => e.status === 'APPROVED');
  expect(example).toBeTruthy();
  await page.goto('/admin/training');
  await expect(
    page.getByText('สอนวิธีตอบจากตัวอย่างที่อนุมัติ ให้ Gemini เรียบเรียงตามบุคลิกที่ตั้งไว้', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^อนุมัติแล้ว/ }).click();
  await page.getByRole('row').filter({ hasText: example.question }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({
    path: 'artifacts/ai-teaching-review.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'เลิกใช้ตัวอย่างนี้', exact: true }).click();
  await expect(page.getByText('เลิกใช้ตัวอย่างแล้ว', { exact: true })).toBeVisible();
  const latest = await page.request.get('/api/training');
  expect((await latest.json()).find((e: any) => e.id === example.id).status).toBe('REVOKED');
});
