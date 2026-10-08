import { useEffect, useState } from 'react';
import { CheckCircle2, Link2, ShieldCheck } from 'lucide-react';
import type { StaffAccount } from '../../shared/types';
import { api, post } from '../api';
import { Avatar, ErrorBox, Loading } from '../components';

export function StaffConnect() {
  const [account, setAccount] = useState<StaffAccount | null>(null),
    [liffId, setLiffId] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [complete, setComplete] = useState(false),
    [candidate, setCandidate] = useState<{ name: string; idToken: string; userId: string } | null>(
      null,
    );
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const session = await api('/auth/me').catch((e) => {
          if (e.status === 401) return null;
          throw e;
        });
        if (session) {
          const [value, config] = await Promise.all([
            api<StaffAccount>('/account'),
            api<{ liffId: string }>('/connect/config'),
          ]);
          if (active) {
            setAccount(value);
            setLiffId(config.liffId);
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const login = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await post('/auth/sso/start', { returnTo: '/admin/account' });
      location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const preview = async () => {
    setBusy(true);
    setError('');
    try {
      const { default: liff } = await import('@line/liff');
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: `${location.origin}/connect/staff` });
        return;
      }
      const idToken = liff.getIDToken(),
        profile = liff.getDecodedIDToken();
      if (!idToken || !profile?.sub)
        throw new Error('ไม่พบข้อมูล LINE กรุณาเปิดสิทธิ์ openid และ profile ของ LIFF');
      // Display only. The server verifies the raw token with LINE before linking.
      setCandidate({ idToken, userId: profile.sub, name: profile.name || 'บัญชี LINE ของคุณ' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="connect-page">
      <div className="connect-card">
        <div className="connect-brand">
          CUSA <span>STAFF CONNECT</span>
        </div>
        <div className={`connect-symbol ${complete || account?.line.verified ? 'success' : ''}`}>
          {complete || account?.line.verified ? <CheckCircle2 size={40} /> : <Link2 size={40} />}
        </div>
        <h1>
          {complete
            ? 'ผูก LINE แล้ว'
            : account?.lineManagedBySso
              ? 'LINE จาก CUSA SSO'
              : 'เชื่อม LINE ของฉัน'}
        </h1>
        {loading ? (
          <Loading />
        ) : (
          <>
            {error && <ErrorBox message={error} />}
            {!account ? (
              <>
                <p>เข้าสู่ CUSA SSO ด้วยบัญชีเจ้าหน้าที่ก่อนผูก LINE</p>
                <button className="button primary full" disabled={busy} onClick={login}>
                  เข้าสู่ CUSA SSO
                </button>
              </>
            ) : complete ? (
              <p>พร้อมรับแจ้งเตือนตามการตั้งค่าของคุณ</p>
            ) : account.lineManagedBySso ? (
              <>
                <p>
                  {account.line.verified ? 'ผูกผ่าน SSO แล้ว' : 'ตรวจสอบการผูก LINE ใน CUSA SSO'}
                </p>
                <div className="connect-privacy">
                  <ShieldCheck size={20} />
                  <span>บัญชี LINE นี้จัดการผ่าน CUSA SSO</span>
                </div>
              </>
            ) : candidate ? (
              <>
                <div className="staff-line-preview">
                  <Avatar name={candidate.name} size="large" />
                  <strong>{candidate.name}</strong>
                  <code>{candidate.userId}</code>
                </div>
                <p>ต้องการผูก LINE นี้กับ {account.agent.name} ใช่ไหม?</p>
                {account.line.userId && (
                  <p className="muted small-text">เมื่อยืนยัน จะใช้ LINE นี้แทนบัญชีเดิม</p>
                )}
                <button
                  className="button primary full"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      const updated = await post<StaffAccount>('/account/line', {
                        source: 'OA_LINK',
                        accountId: account.agent.id,
                        expectedCurrentUserId: account.line.userId,
                        lineIdToken: candidate.idToken,
                      });
                      setAccount(updated);
                      setCandidate(null);
                      setComplete(true);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  ใช่ ผูก LINE นี้
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setCandidate(null);
                    setError('');
                  }}
                >
                  ยังไม่ผูก
                </button>
                <p className="muted small-text">
                  หากเป็นบัญชีอื่น ให้เปิดหน้านี้จาก LINE ที่ต้องการผูก
                </p>
              </>
            ) : (
              <>
                <p>ตรวจสอบชื่อ LINE ก่อนยืนยันผูกกับ {account.agent.name}</p>
                <button
                  className="button primary full"
                  disabled={busy || !account.canLinkLine}
                  onClick={preview}
                >
                  {busy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบ LINE ของฉัน'}
                </button>
                {!account.canLinkLine && (
                  <p className="muted small-text">
                    {account.demo
                      ? 'โหมดทดลองไม่เชื่อม LINE จริง'
                      : 'ยังไม่ได้ตั้งค่าการเชื่อม LINE'}
                  </p>
                )}
              </>
            )}
            <a className="button full account-return" href="/admin/account">
              กลับบัญชีของฉัน
            </a>
          </>
        )}
      </div>
    </div>
  );
}
