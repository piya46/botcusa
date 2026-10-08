import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Rocket,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { installGroups, type InstallInput } from '../../shared/install';
import { staffRoles } from '../../shared/roles';
import { CUSA_CALLBACK_PATH } from '../../shared/sso';

type FieldProps = { label: string; hint?: string; children: ReactNode; wide?: boolean };
function Field({ label, hint, children, wide }: FieldProps) {
  return (
    <label className={`install-field ${wide ? 'wide' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
const initial: InstallInput = {
  origin: location.protocol === 'https:' ? location.origin : '',
  database: {
    host: 'localhost',
    port: 3306,
    name: '',
    user: '',
    password: '',
    tls: false,
    caFile: '',
  },
  services: {
    LINE_LOADING_ENABLED: 'true',
    LINE_LOADING_SECONDS: '30',
    AI_ANALYTICS_ENABLED: 'false',
    GOOGLE_CLOUD_LOCATION: 'global',
    VERTEX_AI_EMBEDDING_LOCATION: 'us-central1',
    CHAT_RETENTION_DAYS: '180',
    DATASET_RETENTION_DAYS: '180',
    CUSA_SSO_ORIGIN: 'https://sso.reunion.scicu-alumni.com',
    CUSA_CLAIM_SCOPES: 'identity:read profile email',
    CUSA_LINE_SAME_PROVIDER: 'false',
  },
};
const steps = ['เว็บและ SSO', 'ฐานข้อมูล', 'บริการเสริม', 'ติดตั้ง'];

export function Install() {
  const [status, setStatus] = useState<'loading' | 'locked' | 'open' | 'done' | 'installed'>(
    'loading',
  );
  const [key, setKey] = useState(''),
    [step, setStep] = useState(0);
  const [form, setForm] = useState<InstallInput>(initial);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<{ version: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false),
    [installedOrigin, setInstalledOrigin] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/install/status', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('อ่านสถานะติดตั้งไม่ได้ กรุณาตรวจว่าเซิร์ฟเวอร์เริ่มแล้ว');
        const value = await r.json();
        if (active)
          setStatus(value.installed ? (value.restartRequired ? 'done' : 'installed') : 'locked');
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setStatus('locked');
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const call = async (action: string, body: unknown = {}) => {
    const response = await fetch(`/api/install/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.trim()}` },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ดำเนินการไม่สำเร็จ');
    return data;
  };
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };
  const update = (key: 'origin', value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setConfirmed(false);
  };
  const database = <K extends keyof InstallInput['database']>(
    key: K,
    value: InstallInput['database'][K],
  ) => {
    setForm((f) => ({ ...f, database: { ...f.database, [key]: value } }));
    setChecked(null);
    setConfirmed(false);
  };
  const proceed = () => {
    if (step === 0) {
      try {
        const origin = new URL(form.origin);
        if (
          origin.protocol !== 'https:' ||
          origin.origin !== form.origin ||
          origin.hostname.endsWith('.invalid')
        )
          throw new Error();
      } catch {
        setError('กรอก HTTPS ของเว็บจริง เช่น https://bot.example.com ไม่มี / ท้าย');
        return;
      }
      try {
        const u = new URL(form.services.CUSA_SSO_ORIGIN);
        if (u.protocol !== 'https:' || u.origin !== form.services.CUSA_SSO_ORIGIN)
          throw new Error();
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            form.services.CUSA_CLIENT_ID || '',
          ) ||
          !form.services.CUSA_API_KEY?.trim()
        )
          throw new Error();
      } catch {
        setError('กรอก SSO Origin, Application UUID และ Backend API key ให้ครบ');
        return;
      }
    }
    setError('');
    setStep((s) => s + 1);
  };
  const checkDatabase = () =>
    run(async () => {
      const result = await call('check', form);
      setChecked({ version: result.version });
    });
  const apply = () =>
    run(async () => {
      const result = await call('apply', form);
      setInstalledOrigin(result.origin);
      setStatus('done');
      setKey('');
      setForm({ ...initial, services: {} });
    });

  return (
    <div className="install-page">
      <header className="install-header">
        <a href="/install" className="install-logo">
          <span>
            <Settings2 size={25} />
          </span>
          <div>
            CUSA<small>MEMBER DESK</small>
          </div>
        </a>
        <span className="install-header-tag">
          <ShieldCheck size={15} /> การติดตั้งครั้งแรก
        </span>
      </header>
      <main className="install-layout">
        <aside className="install-aside">
          <span className="install-eyebrow">LET’S GET STARTED</span>
          <h1>
            ตั้งค่าพื้นฐาน
            <br />
            <em>พร้อมดูแลสมาชิก</em>
          </h1>
          <p>
            เชื่อมฐานข้อมูลและ CUSA SSO
            <br />
            แล้วเปิดใช้งานบริการที่ต้องการ
          </p>
          <ol className="install-steps">
            {steps.map((title, index) => (
              <li
                key={title}
                className={
                  status === 'open' && step === index
                    ? 'current'
                    : status === 'done' ||
                        status === 'installed' ||
                        (status === 'open' && index < step)
                      ? 'complete'
                      : ''
                }
                aria-current={status === 'open' && step === index ? 'step' : undefined}
              >
                <span>
                  {status === 'done' ||
                  status === 'installed' ||
                  (status === 'open' && index < step) ? (
                    <Check size={17} />
                  ) : (
                    `0${index + 1}`
                  )}
                </span>
                <div>
                  {title}
                  <small>
                    {
                      [
                        'โดเมนและการเข้าสู่ระบบ',
                        'MySQL / MariaDB จาก Plesk',
                        'LINE · Vertex AI',
                        'ตรวจสอบและสร้างระบบ',
                      ][index]
                    }
                  </small>
                </div>
              </li>
            ))}
          </ol>
          <div className="install-aside-note">
            <LockKeyhole size={18} />
            <span>
              ค่าลับเก็บบนเซิร์ฟเวอร์
              <br />
              ปิดหน้าติดตั้งเมื่อเสร็จแล้ว
            </span>
          </div>
        </aside>
        <section className="install-card" aria-busy={busy}>
          {error && (
            <div className="install-error" role="alert">
              {error}
            </div>
          )}
          {status === 'loading' ? (
            <div className="install-state">
              <LoaderCircle className="spin" size={30} />
              <p>กำลังตรวจสถานะ…</p>
            </div>
          ) : status === 'locked' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const data = await call('unlock');
                  setForm((f) => ({
                    ...f,
                    origin: data.origin || f.origin,
                  }));
                  setStatus('open');
                });
              }}
            >
              <div className="install-icon">
                <KeyRound size={29} />
              </div>
              <h2>เริ่มจากรหัสติดตั้ง</h2>
              <p className="install-intro">
                เปิดไฟล์ <code>.setup/access.key</code> ใน Plesk File Manager
                แล้วคัดลอกรหัสมาใส่ด้านล่าง
              </p>
              <Field
                label="รหัสติดตั้ง"
                hint="ไฟล์อยู่ใน Application Root นอก public ถ้าไม่เห็น ให้เปิดแสดงไฟล์ซ่อน"
              >
                <input
                  type="password"
                  aria-label="รหัสติดตั้ง"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>
              <button className="button primary install-full" disabled={busy || !key.trim()}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{' '}
                เริ่มตั้งค่า
              </button>
              <div className="install-tip">
                ยังไม่มีไฟล์รหัส? รัน <code>install:web</code> ใน Plesk → Node.js → Run Script แล้ว
                Restart App
              </div>
            </form>
          ) : status === 'done' || status === 'installed' ? (
            <div className="install-success">
              <div className="install-icon">
                <CheckCircle2 size={34} />
              </div>
              <h2>{status === 'done' ? 'ติดตั้งสำเร็จ' : 'ระบบนี้ติดตั้งแล้ว'}</h2>
              <p>
                {status === 'done'
                  ? 'สร้าง .env และตารางข้อมูลแล้ว เข้าสู่ระบบด้วย CUSA SSO'
                  : 'หน้าติดตั้งปิดอยู่ เพื่อรักษาการตั้งค่าเดิม'}
              </p>
              {status === 'done' && (
                <div className="install-tip">
                  <strong>ขั้นตอนสุดท้าย</strong>
                  <p>ไป Plesk → Node.js → Restart App แล้วเปิดเว็บเพื่อเข้าสู่ระบบ</p>
                </div>
              )}
              <a
                className="button primary install-full"
                href={`${installedOrigin || ''}/admin/overview`}
              >
                ไปหน้าเข้าสู่ระบบ <ArrowRight size={17} />
              </a>
              <small>เก็บ .env, .data และฐานข้อมูลไว้ในชุดสำรองเดียวกัน</small>
            </div>
          ) : (
            <>
              <div className="install-step-heading">
                <span>ขั้นตอน {step + 1} / 4</span>
                <span>{step === 2 ? 'ข้ามไปเติมภายหลังได้' : 'กรอกครั้งเดียว'}</span>
              </div>
              <h2>{steps[step]}</h2>
              {step === 0 && (
                <>
                  <p className="install-intro">
                    เจ้าหน้าที่เข้าสู่ระบบด้วย CUSA SSO สิทธิ์ใช้งานกำหนดใน Member Desk
                  </p>
                  <div className="install-fields">
                    <Field label="URL ของเว็บ" hint="โดเมนของแอปนี้ ไม่ใช่ URL ของ CUSA SSO" wide>
                      <input
                        type="url"
                        value={form.origin}
                        onChange={(e) => update('origin', e.target.value.trim())}
                        placeholder="https://bot.reunion.scicu-alumni.com"
                        autoComplete="url"
                        required
                      />
                    </Field>
                    {[
                      [
                        'CUSA_CLAIM_SCOPES',
                        'ข้อมูลที่ขอจาก SSO',
                        'identity:read profile email; เพิ่ม line หากบังคับ LINE UID และเปิดอนุญาตใน Consent แล้ว',
                      ],
                      ['CUSA_SSO_ORIGIN', 'SSO Origin', 'URL ของ CUSA SSO ไม่มี /login ต่อท้าย'],
                      [
                        'CUSA_CLIENT_ID',
                        'Application UUID',
                        'ขอจากผู้ดูแล CUSA สำหรับแอป Member Desk',
                      ],
                      [
                        'CUSA_API_KEY',
                        'Backend API key',
                        'ต้องมีสิทธิ์ identity:read, token:introspect และ token:revoke',
                      ],
                    ].map(([key, label, hint]) => (
                      <Field key={key} label={label} hint={hint} wide>
                        <input
                          type={key === 'CUSA_API_KEY' ? 'password' : 'text'}
                          value={form.services[key] || ''}
                          autoComplete="off"
                          required
                          onChange={(e) => {
                            setForm((f) => ({
                              ...f,
                              services: {
                                ...f.services,
                                [key]:
                                  key === 'CUSA_CLAIM_SCOPES'
                                    ? e.target.value
                                    : e.target.value.trim(),
                              },
                            }));
                            setConfirmed(false);
                          }}
                        />
                      </Field>
                    ))}
                  </div>
                  <Field
                    label="LINE ของ SSO กับ OA อยู่ Provider เดียวกัน"
                    hint="เปิดเมื่อยืนยัน Provider แล้ว ระบบจะขอ line และผูก LINE เจ้าหน้าที่จาก SSO อัตโนมัติ"
                  >
                    <select
                      value={form.services.CUSA_LINE_SAME_PROVIDER}
                      onChange={(e) => {
                        setForm((f) => ({
                          ...f,
                          services: { ...f.services, CUSA_LINE_SAME_PROVIDER: e.target.value },
                        }));
                        setConfirmed(false);
                      }}
                    >
                      <option value="false">คนละ Provider / ยังไม่ยืนยัน</option>
                      <option value="true">Provider เดียวกัน</option>
                    </select>
                  </Field>
                  <div className="install-tip">
                    <strong>ให้ CUSA สร้างบทบาทของแอปตามชื่อนี้</strong>
                    {staffRoles.map((r) => (
                      <p key={r.code}>
                        <code>{r.code}</code> · {r.label}
                        <br />
                        <small>{r.description}</small>
                      </p>
                    ))}
                    <p>
                      กำหนดบทบาท <code>admin</code> ให้ผู้ดูแลก่อนเข้าใช้งานครั้งแรก
                    </p>
                    <p>
                      ลงทะเบียน callback เดียวสำหรับเจ้าหน้าที่และผูก LINE:
                      <br />
                      <code>
                        {form.origin || 'https://โดเมนของคุณ'}
                        {CUSA_CALLBACK_PATH}
                      </code>
                    </p>
                  </div>
                </>
              )}
              {step === 1 && (
                <>
                  <p className="install-intro">
                    สร้างฐานข้อมูลเปล่าใน Plesk → Databases ก่อน ระบบสร้างตารางให้
                  </p>
                  <div className="install-fields">
                    <Field
                      label="Database host"
                      hint="localhost สำหรับฐานข้อมูลบนเซิร์ฟเวอร์เดียวกับแอป"
                    >
                      <input
                        value={form.database.host}
                        onChange={(e) => database('host', e.target.value.trim())}
                        placeholder="localhost"
                        autoComplete="off"
                        required
                      />
                    </Field>
                    <Field label="Port">
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={form.database.port}
                        onChange={(e) => database('port', Number(e.target.value))}
                        required
                      />
                    </Field>
                    <Field label="ชื่อฐานข้อมูล" hint="รวม prefix ของบัญชี Plesk">
                      <input
                        value={form.database.name}
                        onChange={(e) => database('name', e.target.value)}
                        placeholder="account_cusa"
                        autoComplete="off"
                        required
                      />
                    </Field>
                    <Field label="ชื่อผู้ใช้ฐานข้อมูล">
                      <input
                        value={form.database.user}
                        onChange={(e) => database('user', e.target.value)}
                        placeholder="account_cusa_app"
                        autoComplete="off"
                        required
                      />
                    </Field>
                    <Field
                      label="รหัสผ่านฐานข้อมูล"
                      hint="ใส่รหัสจริง ไม่ต้องแปลงอักขระพิเศษ ระบบประกอบ DATABASE_URL ให้"
                      wide
                    >
                      <input
                        type="password"
                        value={form.database.password}
                        onChange={(e) => database('password', e.target.value)}
                        autoComplete="new-password"
                        required
                      />
                    </Field>
                  </div>
                  <label className="install-check">
                    <input
                      type="checkbox"
                      checked={form.database.tls}
                      onChange={(e) => database('tls', e.target.checked)}
                    />{' '}
                    เชื่อมต่อฐานข้อมูลผ่าน TLS
                  </label>
                  {form.database.tls && (
                    <Field
                      label="CA certificate path (ถ้ามี)"
                      hint="path ของไฟล์ CA จากผู้ให้บริการ นอก public; เว้นว่างเมื่อใช้ certificate ที่เชื่อถือได้อยู่แล้ว"
                    >
                      <input
                        value={form.database.caFile}
                        onChange={(e) => database('caFile', e.target.value)}
                        placeholder="/absolute/path/mysql-ca.pem"
                      />
                    </Field>
                  )}
                  <button
                    type="button"
                    className="button secondary install-full"
                    disabled={busy}
                    onClick={checkDatabase}
                  >
                    {busy ? <LoaderCircle className="spin" size={17} /> : <Database size={17} />}{' '}
                    ทดสอบฐานข้อมูล
                  </button>
                  {checked && (
                    <div className="install-check-result" role="status">
                      <CheckCircle2 size={19} />
                      <span>
                        เชื่อมต่อได้ · {checked.version}
                        <small>ตรวจสิทธิ์สร้างตารางอีกครั้งตอนติดตั้ง</small>
                      </span>
                    </div>
                  )}
                  <small className="install-caption">
                    รองรับ MySQL 8.0.17+ / MariaDB 10.6+ ไม่ต้องใช้ pgvector
                  </small>
                </>
              )}
              {step === 2 && (
                <>
                  <p className="install-intro">
                    มีคีย์แล้วใส่ได้เลย หรือข้ามแล้วเติมใน .env ภายหลัง
                  </p>
                  <div className="install-services">
                    {installGroups.map((group) => (
                      <details key={group.title}>
                        <summary>
                          <span>
                            {group.title}
                            <small>{group.description}</small>
                          </span>
                          <ChevronDown size={18} />
                        </summary>
                        <div className="install-fields">
                          {group.fields.map((field) => (
                            <Field
                              key={field.key}
                              label={field.label}
                              hint={'hint' in field ? field.hint : undefined}
                              wide
                            >
                              {'options' in field ? (
                                <select
                                  value={form.services[field.key] || field.options?.[0]}
                                  onChange={(e) => {
                                    setForm((f) => ({
                                      ...f,
                                      services: { ...f.services, [field.key]: e.target.value },
                                    }));
                                    setConfirmed(false);
                                  }}
                                >
                                  {field.options?.map((option) => (
                                    <option key={option} value={option}>
                                      {option === 'true' ? 'เปิด' : 'ปิด'}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type={
                                    'secret' in field && field.secret
                                      ? 'password'
                                      : 'numeric' in field && field.numeric
                                        ? 'number'
                                        : 'text'
                                  }
                                  value={form.services[field.key] || ''}
                                  onChange={(e) => {
                                    setForm((f) => ({
                                      ...f,
                                      services: { ...f.services, [field.key]: e.target.value },
                                    }));
                                    setConfirmed(false);
                                  }}
                                  autoComplete="off"
                                  spellCheck={false}
                                />
                              )}
                            </Field>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                </>
              )}
              {step === 3 && (
                <>
                  <p className="install-intro">
                    ระบบจะสร้างไฟล์ .env พร้อม key เข้ารหัสและตารางข้อมูล
                  </p>
                  <dl className="install-review">
                    <div>
                      <dt>เว็บไซต์</dt>
                      <dd>{form.origin}</dd>
                    </div>
                    <div>
                      <dt>เข้าสู่ระบบ</dt>
                      <dd>
                        CUSA SSO<small>บัญชีเจ้าหน้าที่สร้างเมื่อเข้า SSO ครั้งแรก</small>
                      </dd>
                    </div>
                    <div>
                      <dt>ฐานข้อมูล</dt>
                      <dd>
                        {form.database.name}
                        <small>
                          {form.database.host}:{form.database.port}
                        </small>
                      </dd>
                    </div>
                    <div>
                      <dt>บริการเสริม</dt>
                      <dd>
                        {[
                          form.services.LINE_CHANNEL_ACCESS_TOKEN && 'LINE',
                          form.services.GOOGLE_CLOUD_PROJECT &&
                            form.services.VERTEX_AI_MODEL &&
                            'Vertex AI',
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'เติมภายหลัง'}
                        <small>ยังไม่ได้ทดสอบ API ของผู้ให้บริการ</small>
                      </dd>
                    </div>
                  </dl>
                  <div className="install-tip">
                    <strong>โฮสต์ไม่มี Scheduled Tasks</strong>
                    <p>เมื่อแอปพัก งานตั้งเวลาและแจ้งเตือนจะรอจนมีคนเปิดเว็บหรือมี LINE เข้ามา</p>
                  </div>
                  <label className="install-check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />{' '}
                    ตรวจค่าครบแล้ว และใช้ฐานข้อมูลสำหรับระบบใหม่นี้
                  </label>
                </>
              )}
              <div className="install-footer">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || step === 0}
                  onClick={() => {
                    setStep(step - 1);
                    setError('');
                  }}
                >
                  <ArrowLeft size={17} /> ย้อนกลับ
                </button>
                {step < 3 ? (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || (step === 1 && !checked)}
                    onClick={proceed}
                  >
                    {step === 2 ? 'ตรวจและติดตั้ง' : 'ถัดไป'} <ArrowRight size={17} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || !confirmed}
                    onClick={apply}
                  >
                    {busy ? <LoaderCircle className="spin" size={17} /> : <Rocket size={17} />}{' '}
                    {busy ? 'กำลังติดตั้ง…' : 'ติดตั้งระบบ'}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </main>
      <footer className="install-page-footer">
        CUSA Member Desk <span>คู่มือค่าต่าง ๆ: docs/ENVIRONMENT.md</span>
      </footer>
    </div>
  );
}
