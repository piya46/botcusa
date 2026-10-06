import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleAlert,
  LoaderCircle,
  X,
  Inbox,
  FlaskConical,
} from 'lucide-react';
import { api, notify } from './api';
import type { CaseState, DeliveryState } from '../shared/types';

export function useResource<T>(url: string, interval = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;
  const reload = useCallback(async () => {
    try {
      const value = await api<T>(url);
      if (urlRef.current === url) {
        setData(value);
        setError('');
      }
    } catch (e) {
      if (urlRef.current === url) setError((e as Error).message);
    } finally {
      if (urlRef.current === url) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    setData(null);
    setLoading(true);
    void reload();
    const id = interval ? setInterval(reload, interval) : undefined;
    return () => clearInterval(id);
  }, [reload, interval]);
  return { data, error, loading, reload };
}
export function Avatar({
  name,
  color = 'sage',
  size = 'normal',
}: {
  name: string;
  color?: string;
  size?: 'small' | 'normal' | 'large';
}) {
  return (
    <span className={`avatar ${color} ${size}`} aria-hidden="true">
      {Array.from(name.replace(/^(คุณ|นาย|นางสาว)/, '').trim())
        .slice(0, 1)
        .join('')}
    </span>
  );
}
export const stateLabels: Record<CaseState, string> = {
  BOT: 'ผู้ช่วย AI ดูแล',
  WAITING_FOR_AGENT: 'รอเจ้าหน้าที่',
  AGENT_IN_CHARGE: 'กำลังดูแล',
  CLOSED: 'ปิดเคสแล้ว',
};
export function Status({ state }: { state: CaseState }) {
  return (
    <span className={`badge status-${state.toLowerCase()}`}>
      <i />
      {stateLabels[state]}
    </span>
  );
}
export function Delivery({ state }: { state: DeliveryState }) {
  const labels: Record<DeliveryState, string> = {
    RECEIVED: 'บันทึกแล้ว',
    QUEUED: 'รอส่ง',
    ACCEPTED: 'LINE รับคำขอแล้ว',
    FAILED: 'ส่งไม่สำเร็จ',
    UNKNOWN: 'ยังไม่ทราบผล',
    SIMULATED: 'ส่งจำลองแล้ว',
    CANCELLED: 'ยกเลิกการส่ง',
  };
  const Icon =
    state === 'QUEUED'
      ? LoaderCircle
      : ['FAILED', 'UNKNOWN'].includes(state)
        ? CircleAlert
        : state === 'ACCEPTED'
          ? CheckCheck
          : Check;
  return (
    <span className={`delivery ${['FAILED', 'UNKNOWN'].includes(state) ? 'error' : ''}`}>
      <Icon size={12} className={state === 'QUEUED' ? 'spin' : ''} />
      {labels[state]}
    </span>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={28} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={24} />
      <span>กำลังโหลดข้อมูล…</span>
    </div>
  );
}
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-box">
      <CircleAlert size={18} />
      <span>{message}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          ลองใหม่
        </button>
      )}
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const container = ref.current;
    container?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab' && container) {
        const elements = Array.from(
          container.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,textarea,select,a[href]',
          ),
        );
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handle);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handle);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <div className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="ปิดหน้าต่าง" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Toasts() {
  const [items, setItems] = useState<{ id: number; message: string; type: string }[]>([]);
  useEffect(() => {
    const handler = (e: Event) => {
      const item = { id: Date.now() + Math.random(), ...(e as CustomEvent).detail };
      setItems((prev) => [...prev, item]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== item.id)), 5000);
    };
    window.addEventListener('toast', handler);
    return () => window.removeEventListener('toast', handler);
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.type}`}>
          {item.type === 'error' ? <CircleAlert size={18} /> : <Check size={18} />}
          <span>{item.message}</span>
          <button
            className="icon-button"
            aria-label="ปิดข้อความแจ้งเตือน"
            onClick={() => setItems((x) => x.filter((i) => i.id !== item.id))}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
export function DemoBanner() {
  return (
    <div className="demo-banner">
      <FlaskConical size={14} />
      <span>พื้นที่ทดลอง · ข้อมูลสมาชิกสมมติ และข้อความจะไม่ถูกส่งไป LINE จริง</span>
    </div>
  );
}
export function ExternalArrow() {
  return <ArrowUpRight size={16} />;
}
export async function perform(action: () => Promise<unknown>, message: string, after?: () => void) {
  try {
    await action();
    notify(message);
    after?.();
  } catch (e) {
    notify((e as Error).message, 'error');
  }
}
