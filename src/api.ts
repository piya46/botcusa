export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, data.error ?? 'เกิดข้อผิดพลาด กรุณาลองใหม่');
  return data as T;
}
export const post = <T = any>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export function notify(message: string, type: 'success' | 'error' = 'success') {
  window.dispatchEvent(new CustomEvent('toast', { detail: { message, type } }));
}
export function go(path: string) {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export const formatDate = (value: string | Date, short = false) =>
  new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    ...(short ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).format(new Date(value));
export const clockTime = (value: string) =>
  new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
export function relative(value: string) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return m < 1
    ? 'เมื่อสักครู่'
    : m < 60
      ? `${m} นาที`
      : m < 1440
        ? `${Math.floor(m / 60)} ชม.`
        : formatDate(value, true);
}
