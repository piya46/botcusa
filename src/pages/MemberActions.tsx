import { useState } from 'react';
import { Check, Send } from 'lucide-react';
import { notify, patch, post } from '../api';
import { ErrorBox, Loading, Modal, useResource } from '../components';

export const menuStatus: Record<string, string> = {
  UNCHANGED: 'ยังไม่มีคำสั่ง',
  PENDING: 'รอดำเนินการ',
  ACCEPTED: 'LINE รับคำสั่งแล้ว',
  SIMULATED: 'จำลองเปลี่ยนแล้ว',
  FAILED: 'เปลี่ยนไม่สำเร็จ',
};
export function MemberActions({
  member,
  onClose,
  onUpdate,
}: {
  member: any;
  onClose: () => void;
  onUpdate: () => Promise<unknown>;
}) {
  const menus = useResource<{ richMenuId: string; name: string }[]>('/rich-menus');
  const [tags, setTags] = useState((member.interest_tags ?? []).join(', '));
  const [menuId, setMenuId] = useState(
    member.rich_menu_status === 'PENDING'
      ? (member.rich_menu_target ?? '')
      : (member.rich_menu_id ?? ''),
  );
  const [busy, setBusy] = useState(false);
  async function save(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      await onUpdate();
      notify(success);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="จัดการสมาชิก" subtitle={member.name} onClose={onClose}>
      <section className="member-action-section">
        <h3>หัวข้อความสนใจ</h3>
        <p className="muted small-text">
          เจ้าหน้าที่ระบุจากการดูแลสมาชิก ใช้เลือกกลุ่มข่าวสาร กรุณาใส่เฉพาะหัวข้อที่เกี่ยวข้อง
        </p>
        <label>
          แท็กความสนใจ (คั่นด้วยจุลภาค)
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="กิจกรรมศิษย์เก่า, ลงทะเบียน"
            maxLength={2000}
          />
        </label>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            save(
              () =>
                patch(`/members/${member.id}/interests`, {
                  tags: tags
                    .split(',')
                    .map((t: string) => t.trim())
                    .filter(Boolean),
                }),
              'บันทึกความสนใจแล้ว',
            )
          }
        >
          <Check size={16} />
          บันทึกความสนใจ
        </button>
      </section>
      <section className="member-action-section">
        <h3>Rich Menu รายบุคคล</h3>
        <p className="muted small-text">
          เปลี่ยนเมนูที่สมาชิกเห็นใน LINE การเลือกเมนูไม่เปลี่ยนสถานะยืนยันตัวตนหรือสิทธิ์ CUSA
        </p>
        {menus.loading ? (
          <Loading />
        ) : menus.error ? (
          <ErrorBox message={menus.error} retry={menus.reload} />
        ) : (
          <>
            <label>
              เมนูที่ต้องการ
              <select value={menuId} onChange={(e) => setMenuId(e.target.value)}>
                <option value="">ใช้เมนูเริ่มต้นของ OA (ปลดเมนูรายบุคคล)</option>
                {menuId && !menus.data?.some((m) => m.richMenuId === menuId) && (
                  <option value={menuId} disabled>
                    เมนูเดิมไม่อยู่ในรายการ
                  </option>
                )}
                {menus.data?.map((m) => (
                  <option key={m.richMenuId} value={m.richMenuId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-footer">
              <span
                className={`badge ${member.rich_menu_status === 'FAILED' ? 'failed' : 'neutral'}`}
              >
                {menuStatus[member.rich_menu_status] ?? 'ยังไม่มีคำสั่ง'}
              </span>
              <button
                className="button primary"
                disabled={
                  busy ||
                  member.blocked ||
                  Boolean(menuId && !menus.data?.some((m) => m.richMenuId === menuId))
                }
                onClick={() =>
                  save(
                    () => post(`/members/${member.id}/rich-menu`, { menuId: menuId || null }),
                    'นำคำสั่งเปลี่ยนเมนูเข้าคิวแล้ว',
                  )
                }
              >
                <Send size={16} />
                ยืนยันเปลี่ยนเมนู
              </button>
            </div>
            {member.blocked && (
              <p className="muted small-text">สมาชิกบล็อก OA อยู่ จึงยังเปลี่ยนเมนูไม่ได้</p>
            )}
          </>
        )}
      </section>
    </Modal>
  );
}
