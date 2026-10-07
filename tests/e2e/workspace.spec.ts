import { test, expect } from '@playwright/test';
import { waitForWorkspace } from './support';

test.beforeEach(async ({ request }, info) => {
  await waitForWorkspace(request, info);
});

test('desktop workflow: claim, durable reply, close, review as a second agent, export dataset', async ({
  page,
}) => {
  const subject = `ขอติดต่อเจ้าหน้าที่ ทดสอบชุดฝึก ${Date.now().toString(36)}`;
  const datasetName = `ทดสอบ workflow สมาชิก ${Date.now().toString(36)}`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin/overview');
  await expect(page.getByRole('heading', { name: 'ภาพรวมวันนี้' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/overview-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'เปิดกล่องข้อความ' }).click();
  await page.getByRole('button', { name: 'จำลองข้อความจากสมาชิก', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill(subject);
  await dialog.getByRole('button', { name: 'ส่งข้อความจำลอง' }).click();
  await page.getByRole('textbox', { name: 'ค้นหาบทสนทนา' }).fill(subject);
  await page.locator('.conversation-item').first().click();
  await page.getByRole('button', { name: 'รับเคสนี้' }).click();
  await expect(page.getByRole('textbox', { name: 'ข้อความตอบสมาชิก' })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'ข้อความตอบสมาชิก' })
    .fill('สวัสดีค่ะ สามารถยืนยันตัวตนด้วย CUSA SSO ผ่านเมนู LINE ได้เลยค่ะ');
  await page.getByRole('button', { name: 'ส่งข้อความ', exact: true }).click();
  await expect(
    page
      .locator('.message-bubble')
      .filter({ hasText: 'สามารถยืนยันตัวตนด้วย CUSA SSO ผ่านเมนู LINE' }),
  ).toBeVisible();
  await expect(page.locator('.delivery').filter({ hasText: 'ส่งจำลองแล้ว' }).last()).toBeVisible();
  await page.screenshot({ path: 'artifacts/inbox-desktop.png', fullPage: true });
  await page.reload();
  await page.getByRole('textbox', { name: 'ค้นหาบทสนทนา' }).fill(subject);
  await page.locator('.conversation-item').first().click();
  await expect(
    page
      .locator('.message-bubble')
      .filter({ hasText: 'สามารถยืนยันตัวตนด้วย CUSA SSO ผ่านเมนู LINE' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'ปิดเคส', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'สรุปการช่วยเหลือ' })
    .fill('สมาชิกได้รับคำแนะนำและยืนยันว่าเข้าสู่ระบบได้แล้ว');
  await page.getByRole('button', { name: 'ยืนยันปิดเคส' }).click();
  if (!(await page.getByRole('button', { name: 'สร้างตัวอย่างฝึก' }).isVisible()))
    await page.getByRole('button', { name: 'แสดงหรือซ่อนรายละเอียด' }).click();
  await page.getByRole('button', { name: 'สร้างตัวอย่างฝึก' }).click();
  await expect(page.getByText('สร้างฉบับร่างแล้ว ไปตรวจทานในชุดข้อมูล AI')).toBeVisible();
  await page.getByRole('link', { name: 'ชุดข้อมูล AI' }).click();
  await page.locator('.question-cell').filter({ hasText: subject }).first().click();
  await expect(page.getByRole('button', { name: 'อนุมัติตัวอย่าง', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).first().click();
  await page.getByLabel('สลับบัญชีทดลอง').selectOption('22222222-2222-4222-8222-222222222222');
  await page.locator('.question-cell').filter({ hasText: subject }).first().click();
  await page.getByLabel('ตรวจแล้วว่าไม่มีข้อมูลส่วนบุคคลที่ไม่ควรใช้ฝึก').check();
  await page.getByLabel('ตรวจความถูกต้องของคำตอบและบริบทแล้ว').check();
  await page.getByRole('button', { name: 'อนุมัติตัวอย่าง', exact: true }).click();
  await page.getByRole('button', { name: 'สร้างชุดข้อมูล', exact: true }).click();
  await page.getByRole('textbox', { name: 'ชื่อชุดข้อมูล' }).fill(datasetName);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'สร้างชุดข้อมูล', exact: true })
    .click();
  await expect(page.getByText(datasetName, { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'train', exact: true }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.jsonl$/);
  await page.screenshot({ path: 'artifacts/training-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('mobile inbox and management pages fit the viewport without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/inbox');
  await expect(page.getByRole('heading', { name: /กล่องข้อความ/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/inbox-mobile.png', fullPage: true });
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.chat-header')).toBeVisible();
  await page.screenshot({ path: 'artifacts/conversation-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'กลับไปรายการ' }).click();
  await expect(page.getByRole('heading', { name: /กล่องข้อความ/ })).toBeVisible();
  for (const route of [
    'overview',
    'tickets',
    'knowledge',
    'members',
    'training',
    'broadcasts',
    'settings',
  ]) {
    await page.goto(`/admin/${route}`);
    await expect(page.locator('main h1')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      route,
    ).toBe(true);
  }
});

test('a ticket can be transferred to a department and named owner, accepted and resolved without losing the conversation', async ({
  page,
}) => {
  test.setTimeout(120000);
  const subject = `ขอติดต่อเจ้าหน้าที่ ทดสอบโอนเคส ${Date.now().toString(36)}`;
  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'ตั้งค่า LINE นลิน · เจ้าหน้าที่', exact: true }).click();
  await page.getByLabel('LINE User ID ของเจ้าหน้าที่').fill('U33333333333333333333333333333333');
  await page.getByRole('checkbox', { name: /รับแจ้งเตือนเคสส่งต่อ/ }).check();
  await page.getByRole('button', { name: 'บันทึก LINE เจ้าหน้าที่' }).click();
  await expect(page.getByText('บันทึกการแจ้งเตือน LINE แล้ว')).toBeVisible();
  await page.screenshot({ path: 'artifacts/settings-line-desktop.png', fullPage: true });
  await page.goto('/admin/inbox');
  await page.getByRole('button', { name: 'จำลองข้อความจากสมาชิก', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(subject);
  await page.getByRole('button', { name: 'ส่งข้อความจำลอง', exact: true }).click();
  await page.getByRole('textbox', { name: 'ค้นหาบทสนทนา' }).fill(subject);
  await expect(page.locator('.conversation-item')).toHaveCount(1);
  await page.locator('.conversation-item').click();
  await page.getByRole('button', { name: 'รับเคสนี้' }).click();
  await page
    .getByRole('textbox', { name: 'ข้อความตอบสมาชิก' })
    .fill('ตรวจสอบเบื้องต้นแล้ว จะส่งให้ทีมบัญชีช่วยตรวจต่อค่ะ');
  await page.getByRole('button', { name: 'ส่งข้อความ', exact: true }).click();
  await page.getByRole('button', { name: 'ปิดเคส', exact: true }).click();
  await page.getByLabel('ผลการดูแล').selectOption('UNRESOLVED');
  await page.getByRole('button', { name: 'โอนไปหน่วยงานที่เกี่ยวข้อง' }).click();
  await page.getByLabel('หน่วยงานปลายทาง').selectOption({ label: 'งานระบบและบัญชี CUSA' });
  await page.getByLabel('ผู้รับผิดชอบปลายทาง').selectOption('33333333-3333-4333-8333-333333333333');
  await page
    .getByLabel('เหตุผลและสิ่งที่ต้องดำเนินการต่อ')
    .fill('ตรวจสอบขั้นตอนแล้ว สมาชิกยังยืนยันบัญชีไม่ได้ ขอให้ทีมบัญชีตรวจสอบต่อ');
  await page.getByRole('button', { name: 'ยืนยันโอนเคส', exact: true }).click();
  await expect(page.getByText('โอนเคสและแจ้งเตือนผู้รับในระบบแล้ว')).toBeVisible();
  await expect(page.locator('.ticket-context')).toContainText('งานระบบและบัญชี CUSA');
  await expect(page.getByRole('textbox', { name: 'ข้อความตอบสมาชิก' })).toHaveCount(0);
  const response = await page.request.get(
    `/api/conversations?search=${encodeURIComponent(subject)}`,
  );
  const [ticket] = await response.json();
  await page.getByLabel('สลับบัญชีทดลอง').selectOption('33333333-3333-4333-8333-333333333333');
  await page.getByRole('button', { name: /การแจ้งเตือนเคส/ }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button')
      .filter({ hasText: `เคส #${ticket.number} ` }),
  ).toContainText('LINE: ส่งจำลองแล้ว', { timeout: 15000 });
  await page
    .getByRole('dialog')
    .getByRole('button')
    .filter({ hasText: `เคส #${ticket.number} ` })
    .click();
  await expect(page.locator('.ticket-context')).toContainText('นลิน');
  await page.getByRole('button', { name: 'รับเคสนี้' }).click();
  await page.getByRole('button', { name: 'ประวัติการโอนเคส', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('สมาชิกยังยืนยันบัญชีไม่ได้');
  await expect(page.getByRole('dialog')).toContainText('รับงานเมื่อ');
  await page.getByRole('dialog').getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
  await expect(
    page
      .locator('.message-bubble')
      .filter({ hasText: 'ตรวจสอบเบื้องต้นแล้ว จะส่งให้ทีมบัญชีช่วยตรวจต่อค่ะ' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'ข้อความตอบสมาชิก' })
    .fill('ทีมบัญชีตรวจสอบและแก้ไขแล้ว สามารถยืนยันตัวตนได้ค่ะ');
  await page.getByRole('button', { name: 'ส่งข้อความ', exact: true }).click();
  await page.getByRole('button', { name: 'ปิดเคส', exact: true }).click();
  await page
    .getByLabel('สรุปการช่วยเหลือ')
    .fill('ทีมปลายทางแก้บัญชีเรียบร้อย สมาชิกเข้าใช้งานได้แล้ว');
  await page.getByRole('button', { name: 'ยืนยันปิดเคส' }).click();
  await expect(page.getByText('บทสนทนานี้ปิดแล้ว', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'เคสและการส่งต่อ', exact: true }).click();
  await page.getByLabel('สถานะ Ticket').selectOption('CLOSED');
  await page.getByLabel('ค้นหา Ticket').fill(subject);
  await expect(page.getByRole('row').filter({ hasText: subject })).toContainText(
    'งานระบบและบัญชี CUSA',
  );
  await page.screenshot({ path: 'artifacts/tickets-desktop.png', fullPage: true });
});

test('member interests and rich menu changes feed an exact broadcast audience preview', async ({
  page,
}) => {
  const tag = `กิจกรรมทดสอบ ${Date.now().toString(36)}`;
  await page.goto('/admin/members');
  await page
    .getByRole('button', { name: /^จัดการสมาชิก / })
    .first()
    .click();
  await page.getByLabel('แท็กความสนใจ (คั่นด้วยจุลภาค)').fill(tag);
  await page.getByRole('button', { name: 'บันทึกความสนใจ', exact: true }).click();
  await expect(page.getByText('บันทึกความสนใจแล้ว', { exact: true })).toBeVisible();
  await page.getByLabel('เมนูที่ต้องการ').selectOption({ label: 'Member · เมนูสมาชิก (ทดลอง)' });
  await page.getByRole('button', { name: 'ยืนยันเปลี่ยนเมนู', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('จำลองเปลี่ยนแล้ว', { exact: true })).toBeVisible(
    { timeout: 10000 },
  );
  await page.getByLabel('เมนูที่ต้องการ').selectOption('');
  await page.getByRole('button', { name: 'ยืนยันเปลี่ยนเมนู', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('จำลองเปลี่ยนแล้ว', { exact: true })).toBeVisible(
    { timeout: 10000 },
  );
  await page.getByRole('dialog').getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
  await page.getByRole('link', { name: 'บรอดแคสต์', exact: true }).click();
  await page.getByRole('button', { name: 'สร้างบรอดแคสต์', exact: true }).click();
  await page.getByRole('checkbox', { name: tag, exact: true }).check();
  await expect(page.getByRole('status')).toContainText('กลุ่มนี้มี 1 ผู้รับในระบบ');
  await page.screenshot({ path: 'artifacts/audience-desktop.png', fullPage: true });
});

test('administrators can configure departments and their responsible agents on mobile', async ({
  page,
}) => {
  const title = `หน่วยงานทดสอบ ${Date.now().toString(36)}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/tickets');
  await page.getByRole('button', { name: 'จัดการหน่วยงาน', exact: true }).click();
  await page.getByRole('button', { name: 'เพิ่มหน่วยงาน', exact: true }).click();
  await page.getByLabel('ชื่อหน่วยงาน', { exact: true }).fill(title);
  await page
    .getByLabel('ขอบเขตงาน', { exact: true })
    .fill('รับตรวจสอบเคสที่ส่งต่อจากทีมดูแลสมาชิก');
  await page.getByRole('checkbox', { name: 'นลิน · เจ้าหน้าที่', exact: true }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/team-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'บันทึกหน่วยงาน', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button').filter({ hasText: title }),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button').filter({ hasText: title }).click();
  await page.getByLabel('เปิดรับเคสใหม่').uncheck();
  await page.getByRole('button', { name: 'บันทึกหน่วยงาน', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button').filter({ hasText: title }),
  ).toContainText('ปิดรับงาน');
});

test('knowledge approval and broadcast forms persist changes through their full workflows', async ({
  page,
}) => {
  const suffix = Date.now().toString(36),
    title = `ความรู้ทดสอบ ${suffix}`;
  await page.goto('/admin/knowledge');
  await page.getByRole('button', { name: 'เพิ่มความรู้', exact: true }).click();
  await page.getByRole('textbox', { name: 'หัวข้อ / คำถาม' }).fill(title);
  await page
    .getByRole('textbox', { name: 'คำตอบที่เป็นทางการ' })
    .fill('การยืนยันตัวตนสมาชิกเริ่มจากเมนู LINE และเข้าสู่ CUSA SSO ตามขั้นตอนที่แสดง');
  await page.getByRole('textbox', { name: 'คำค้นหา (คั่นด้วยจุลภาค)' }).fill(`ทดสอบ, ${suffix}`);
  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).click();
  const card = page.locator('.knowledge-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'ตรวจทานและเผยแพร่' }).click();
  await expect(page.getByText('ให้ผู้ตรวจทานอีกคนอนุมัติเนื้อหาที่คุณแก้ไข')).toBeVisible();
  await page.getByLabel('สลับบัญชีทดลอง').selectOption('22222222-2222-4222-8222-222222222222');
  await card.getByRole('button', { name: 'ตรวจทานและเผยแพร่' }).click();
  await expect(card.getByText('เผยแพร่แล้ว')).toBeVisible();
  await page.getByLabel('สลับบัญชีทดลอง').selectOption('11111111-1111-4111-8111-111111111111');
  await page.getByRole('link', { name: 'บรอดแคสต์' }).click();
  await page.getByRole('button', { name: 'สร้างบรอดแคสต์', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'ชื่อรายการ (ทีมงานเห็นเท่านั้น)' })
    .fill(`ข่าวทดสอบ ${suffix}`);
  await page
    .getByRole('textbox', { name: 'ข้อความที่สมาชิกจะได้รับ' })
    .fill('ข้อความทดสอบสำหรับพื้นที่ทดลอง CUSA Member Desk เท่านั้น');
  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).click();
  const row = page.getByRole('row').filter({ hasText: `ข่าวทดสอบ ${suffix}` });
  await row.getByRole('button', { name: 'ตรวจและส่ง' }).click();
  await page.getByRole('button', { name: 'จำลองส่งทันที' }).click();
  await expect(row.getByText('จำลองส่งครบแล้ว')).toBeVisible({ timeout: 10000 });
});
