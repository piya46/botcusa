import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Link2, ShieldCheck } from 'lucide-react';
import { api, post } from '../api';
import { ErrorBox, Loading } from '../components';

export function Connect() {
  const [config, setConfig] = useState<{
      liffId: string;
      available: boolean;
      demo: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const result = new URLSearchParams(location.search).get('result');
  useEffect(() => {
    api('/connect/config')
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  const connect = async () => {
    if (!config?.available) return;
    setBusy(true);
    setError('');
    try {
      const { default: liff } = await import('@line/liff');
      await liff.init({ liffId: config.liffId });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: `${location.origin}/connect` });
        return;
      }
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error('ไม่พบ LINE ID token กรุณาตรวจสอบ scope openid ของ LIFF');
      const { url } = await post('/connect/start', { idToken });
      location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="connect-page">
      <div className="connect-card">
        <div className="connect-brand">
          CUSA <span>MEMBER CONNECT</span>
        </div>
        <div className={`connect-symbol ${result === 'success' ? 'success' : ''}`}>
          {result === 'success' ? <CheckCircle2 size={40} /> : <Link2 size={40} />}
        </div>
        <h1>{result === 'success' ? 'เชื่อมต่อกันแล้ว' : 'ยืนยันตัวตนสมาชิก'}</h1>
        <p>
          {result === 'success'
            ? 'บัญชี CUSA ของคุณเชื่อมกับ LINE แล้ว กลับไปที่แชตเพื่อใช้บริการสมาชิกได้เลย'
            : 'เชื่อมบัญชี CUSA กับ LINE เพื่อเข้าถึงข้อมูลและบริการสำหรับสมาชิกศิษย์เก่า'}
        </p>
        {result && result !== 'success' && (
          <ErrorBox
            message={
              result === 'conflict'
                ? 'บัญชี CUSA นี้ผูกกับ LINE อื่นอยู่แล้ว กรุณาติดต่อเจ้าหน้าที่'
                : 'การยืนยันตัวตนไม่สำเร็จหรือหมดเวลา กรุณาเริ่มใหม่'
            }
          />
        )}
        <div className="connect-privacy">
          <ShieldCheck size={20} />
          <span>
            ยืนยันตัวตนผ่าน CUSA SSO
            <br />
            ตรวจสอบข้อมูลที่จะแบ่งปันก่อนอนุมัติ
          </span>
        </div>
        {error && <ErrorBox message={error} />}{' '}
        {!config ? (
          <Loading />
        ) : result === 'success' ? (
          <button
            className="button primary full"
            onClick={async () => {
              const { default: liff } = await import('@line/liff');
              if (config.liffId) {
                await liff.init({ liffId: config.liffId });
                if (liff.isInClient()) {
                  liff.closeWindow();
                  return;
                }
              }
              setError('คุณสามารถปิดหน้าต่างนี้และกลับไปยังแชต LINE ได้');
            }}
          >
            กลับไปยัง LINE <ArrowRight size={18} />
          </button>
        ) : (
          <button
            className="button primary full"
            disabled={!config.available || busy}
            onClick={connect}
          >
            {busy
              ? 'กำลังเชื่อมต่อ…'
              : config.available
                ? 'เข้าสู่ระบบ CUSA'
                : 'ยังไม่เปิดเชื่อมต่อ SSO จริง'}
            <ArrowRight size={18} />
          </button>
        )}
        <small>Faculty of Science · Chulalongkorn University Alumni</small>
      </div>
    </div>
  );
}
