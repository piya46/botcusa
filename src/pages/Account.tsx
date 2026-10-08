import { useState } from 'react';
import { Bell, ExternalLink, Link2, ShieldCheck, Unlink, UserRound } from 'lucide-react';
import type { StaffAccount } from '../../shared/types';
import { api, notify, patch, post } from '../api';
import { Avatar, ErrorBox, Loading, Modal, PageTitle, useResource } from '../components';

export function AccountPage() {
  const account = useResource<StaffAccount>('/account');
  const [busy, setBusy] = useState(false),
    [removing, setRemoving] = useState(false);
  const [publicName, setPublicName] = useState<string | null>(null);
  if (account.loading) return <Loading />;
  if (account.error) return <ErrorBox message={account.error} retry={account.reload} />;
  if (!account.data) return null;
  const data = account.data;
  const role = { ADMIN: 'ผู้ดูแลระบบ', AGENT: 'เจ้าหน้าที่', REVIEWER: 'ผู้ตรวจทาน' }[
    data.agent.role
  ];
  const proof = { accountId: data.agent.id, expectedCurrentUserId: data.line.userId };
  const changeAlerts = async (enabled: boolean) => {
    setBusy(true);
    try {
      await patch('/account/line', { ...proof, enabled });
      await account.reload();
      notify(enabled ? 'เปิดแจ้งเตือน LINE แล้ว' : 'ปิดแจ้งเตือน LINE แล้ว');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageTitle
        eyebrow="MY ACCOUNT"
        title="บัญชีของฉัน"
        description="ข้อมูลบัญชีและการแจ้งเตือนส่วนตัว"
      />
      <div className="account-grid">
        <section className="panel settings-panel">
          <div className="panel-heading">
            <h2>
              <UserRound size={19} />
              บัญชี CUSA
            </h2>
          </div>
          <div className="account-identity">
            <Avatar name={data.agent.name} size="large" />
            <div>
              <h3>{data.agent.name}</h3>
              <span className="badge neutral">{role}</span>
            </div>
          </div>
          {!data.agent.email.endsWith('@sso.invalid') && (
            <p className="muted account-email">{data.agent.email}</p>
          )}
          <div className="form-info">
            <ShieldCheck size={18} />
            <span>จัดการเคสและข้อมูลตามสิทธิ์ {role}</span>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await patch('/account/profile', {
                  publicDisplayName: publicName ?? data.publicDisplayName ?? '',
                });
                await account.reload();
                setPublicName(null);
                notify('บันทึกชื่อแสดงผลแล้ว');
              } catch (error) {
                notify((error as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              ชื่อที่แนะนำตัวเมื่อรับเคส
              <input
                maxLength={80}
                value={publicName ?? data.publicDisplayName ?? ''}
                placeholder={data.agent.name}
                onChange={(e) => setPublicName(e.target.value)}
              />
            </label>
            <p className="muted small-text">เว้นว่างเพื่อใช้ชื่อจาก SSO</p>
            <div className="form-info">
              เจ้าหน้าที่ {(publicName ?? data.publicDisplayName)?.trim() || data.agent.name}{' '}
              รับเรื่องแล้วค่ะ กำลังตรวจสอบข้อมูลให้
            </div>
            <button className="button primary" disabled={busy || publicName === null}>
              บันทึกชื่อแสดงผล
            </button>
          </form>
        </section>
        <section className="panel settings-panel">
          <div className="panel-heading">
            <h2>
              <Link2 size={19} />
              LINE ของฉัน
            </h2>
          </div>
          <span className={`badge ${data.line.verified ? 'approved' : 'neutral'}`}>
            {data.line.verified
              ? data.line.source === 'SSO'
                ? 'ผูกผ่าน SSO แล้ว'
                : 'ผูก LINE แล้ว'
              : data.line.userId
                ? 'ต้องยืนยัน LINE อีกครั้ง'
                : 'ยังไม่ผูก LINE'}
          </span>
          {data.line.userId && (
            <label className="account-line-id">
              LINE User ID<code>{data.line.userId}</code>
            </label>
          )}
          {data.lineManagedBySso ? (
            <>
              <p className="muted small-text">บัญชี LINE นี้จัดการผ่าน CUSA SSO</p>
              {!data.line.verified && (
                <button
                  className="button"
                  disabled={busy || data.demo}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const { url } = await post('/auth/sso/start', { returnTo: '/admin/account' });
                      location.assign(url);
                    } catch (e) {
                      notify((e as Error).message, 'error');
                      setBusy(false);
                    }
                  }}
                >
                  ตรวจสอบผ่าน SSO อีกครั้ง <ExternalLink size={16} />
                </button>
              )}
            </>
          ) : (
            <>
              <p className="muted small-text">ยืนยัน LINE ที่ต้องการใช้รับแจ้งเตือนเคสของคุณ</p>
              {data.canLinkLine ? (
                <a className="button primary" href="/connect/staff">
                  <Link2 size={16} />
                  {data.line.userId ? 'ผูก LINE ใหม่' : 'ผูก LINE'}
                </a>
              ) : (
                <p className="muted small-text">
                  {data.demo
                    ? 'โหมดทดลองไม่เชื่อม LINE จริง'
                    : 'ยังไม่ได้ตั้งค่าการเชื่อม LINE กรุณาติดต่อผู้ดูแล'}
                </p>
              )}
              {data.line.userId && (
                <button
                  className="text-button account-unlink"
                  disabled={busy}
                  onClick={() => setRemoving(true)}
                >
                  <Unlink size={15} />
                  ยกเลิกการผูก LINE
                </button>
              )}
            </>
          )}
          <label className="switch-row account-alerts">
            <div>
              <strong>
                <Bell size={16} /> รับแจ้งเตือนเคส
              </strong>
              <span>
                {data.agent.role === 'REVIEWER'
                  ? 'บทบาทผู้ตรวจทานไม่มีหน้าที่รับเคส'
                  : 'เพิ่ม OA เป็นเพื่อนเพื่อรับแจ้งเตือน'}
              </span>
            </div>
            <input
              type="checkbox"
              className="switch"
              aria-label="รับแจ้งเตือนเคส"
              checked={data.line.enabled}
              disabled={
                busy ||
                (!data.line.enabled && (!data.line.verified || data.agent.role === 'REVIEWER'))
              }
              onChange={(e) => void changeAlerts(e.target.checked)}
            />
          </label>
        </section>
      </div>
      {removing && !data.lineManagedBySso && (
        <Modal
          title="ยกเลิกการผูก LINE นี้?"
          subtitle="หยุดแจ้งเตือนส่วนตัวและการรับเคสจาก LINE นี้"
          onClose={() => {
            if (!busy) setRemoving(false);
          }}
        >
          <p>คุณยังใช้งาน Member Desk ตามสิทธิ์เดิมได้</p>
          <div className="modal-footer">
            <button className="button" disabled={busy} onClick={() => setRemoving(false)}>
              กลับ
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/account/line', { method: 'DELETE', body: JSON.stringify(proof) });
                  setRemoving(false);
                  await account.reload();
                  notify('ยกเลิกการผูก LINE แล้ว');
                } catch (e) {
                  notify((e as Error).message, 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              ยืนยันยกเลิก
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
