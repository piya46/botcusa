import type { Config } from './config.js';
import { enqueue, type Queryable } from './db.js';
import { lineRequest, type Fetcher } from './providers.js';
import { AppError } from './security.js';

export const demoRichMenus = [
  { richMenuId: 'richmenu-11111111111111111111111111111111', name: 'Member · เมนูสมาชิก (ทดลอง)' },
  {
    richMenuId: 'richmenu-22222222222222222222222222222222',
    name: 'Guest · เมนูผู้เยี่ยมชม (ทดลอง)',
  },
];
export async function listRichMenus(config: Config, fetcher: Fetcher = fetch) {
  if (config.demo) return demoRichMenus;
  const result = await lineRequest(config, '/v2/bot/richmenu/list', undefined, undefined, fetcher);
  return (result.richmenus ?? []).map((m: { richMenuId: string; name: string }) => ({
    richMenuId: m.richMenuId,
    name: m.name,
  }));
}
// Caller owns the transaction. Updating the user serializes manual changes and SSO changes.
export async function queueRichMenu(db: Queryable, userId: string, menuId: string | null) {
  const [user] = await db.query(
    `UPDATE users SET rich_menu_target=$2,rich_menu_revision=rich_menu_revision+1,rich_menu_status='PENDING',updated_at=now() WHERE id=$1 RETURNING rich_menu_revision`,
    [userId, menuId],
  );
  if (!user) throw new AppError(404, 'ไม่พบสมาชิก');
  await enqueue(
    db,
    'RICH_MENU',
    { userId, menuId, revision: user.rich_menu_revision },
    `rich-menu:${userId}:${user.rich_menu_revision}`,
  );
  return { status: 'PENDING', revision: user.rich_menu_revision };
}
