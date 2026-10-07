import { test, expect } from '@playwright/test';
import { waitForWorkspace } from './support';

test.beforeEach(async ({ request }, info) => {
  await waitForWorkspace(request, info);
});

test('document upload, source preview, second-person approval and archive', async ({ page }) => {
  const title = `คู่มือสมาชิก ${Date.now().toString(36)}`;
  const content =
    'คู่มือการใช้บริการสำหรับสมาชิก ให้แจ้งหัวข้อที่ต้องการความช่วยเหลือและรอเจ้าหน้าที่รับเรื่องในเวลาทำการ';
  await page.goto('/admin/knowledge');
  await page.getByRole('button', { name: 'อัปโหลดคู่มือ' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ชื่อคู่มือ').fill(title);
  await dialog
    .getByLabel('ไฟล์ PDF หรือ TXT')
    .setInputFiles({ name: 'handbook.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
  await dialog.getByRole('button', { name: 'นำเข้าเป็นฉบับร่าง' }).click();
  const doc = page.locator('.document-row').filter({ hasText: title });
  await expect(doc).toContainText('1 หน้า · 1 ส่วน · เผยแพร่ 0 ส่วน', { timeout: 15000 });
  await doc.getByRole('button', { name: 'ตรวจเนื้อหา', exact: true }).click();
  const card = page.locator('.knowledge-card').filter({ hasText: title });
  await expect(card).toContainText(content);
  await expect(card.getByRole('link', { name: 'ต้นฉบับ · หน้า 1' })).toBeVisible();
  await card.getByRole('button', { name: 'ตรวจทานและเผยแพร่' }).click();
  await expect(page.getByText('ให้ผู้ตรวจทานอีกคนอนุมัติเนื้อหาที่คุณแก้ไข')).toBeVisible();
  await page.getByLabel('สลับบัญชีทดลอง').selectOption('22222222-2222-4222-8222-222222222222');
  await card.getByRole('button', { name: 'ตรวจทานและเผยแพร่' }).click();
  await expect(card.locator('.badge')).toHaveText('เผยแพร่แล้ว');
  await page.screenshot({ path: 'artifacts/knowledge-documents-desktop.png', fullPage: true });
  await doc.getByRole('button', { name: `เก็บถาวร ${title}`, exact: true }).click();
  await expect(card.locator('.badge')).toHaveText('เก็บถาวร');
  await expect(card.getByRole('button', { name: 'แก้ไข' })).toBeDisabled();
});

test('mobile missing-question workflow creates a draft and shows honest analytics availability', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const question = `xylophonicquasar${Date.now().toString(36)}`;
  await page.goto('/admin/inbox');
  await page.getByRole('button', { name: 'จำลองข้อความจากสมาชิก', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill(question);
  await dialog.getByRole('button', { name: 'ส่งข้อความจำลอง' }).click();
  await page.goto('/admin/insights');
  const gap = page.locator('.insight-card').filter({ hasText: question });
  await expect(gap).toBeVisible({ timeout: 15000 });
  await gap.getByRole('button', { name: 'เติมคำตอบ', exact: true }).click();
  await page.getByLabel('หัวข้อ / คำถาม').fill(`คำตอบทดสอบ ${question}`);
  await page
    .getByLabel('คำตอบที่ตรวจสอบแล้ว')
    .fill('เจ้าหน้าที่ตรวจสอบแล้วว่าต้องแจ้งรายละเอียดเพิ่มเติมและติดตามกับหน่วยงานที่รับผิดชอบ');
  await page.getByRole('button', { name: 'สร้างฉบับร่าง', exact: true }).click();
  await page.getByLabel('สถานะคำถามค้าง').selectOption('DRAFTED');
  await expect(gap.getByRole('button', { name: 'ตรวจฉบับร่าง' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/insights-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await gap.getByRole('button', { name: 'ตรวจฉบับร่าง' }).click();
  await expect(page.locator('.knowledge-card')).toHaveCount(1);
  await expect(page.locator('.knowledge-card .badge')).toHaveText('ฉบับร่าง');
  await page.goto('/admin/insights');
  await page.getByRole('button', { name: 'วิเคราะห์หลังจบเคส', exact: true }).click();
  await expect(page.getByText('ยังไม่เปิดใช้การวิเคราะห์ AI', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'วิเคราะห์เคส', exact: true })).toHaveCount(0);
});
