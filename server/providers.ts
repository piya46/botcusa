import type { Config } from './config.js';
import { AppError } from './security.js';

export type Fetcher = typeof fetch;
export class ProviderError extends Error {
  constructor(
    public status: number,
    public uncertain: boolean,
    message: string,
  ) {
    super(message);
  }
}
export async function lineRequest(
  config: Config,
  path: string,
  body?: unknown,
  retryKey?: string,
  fetcher: Fetcher = fetch,
  method?: 'GET' | 'POST' | 'DELETE',
) {
  if (config.demo) return { simulated: true };
  if (!config.lineToken)
    throw new ProviderError(503, false, 'ยังไม่ได้ตั้งค่า LINE Channel Access Token');
  let response: Response;
  try {
    response = await fetcher(`https://api.line.me${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${config.lineToken}`,
        'Content-Type': 'application/json',
        ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ProviderError(0, true, 'ติดต่อ LINE ไม่สำเร็จ ยังไม่ทราบผลการส่ง');
  }
  if (response.status === 409 && retryKey && response.headers.has('x-line-accepted-request-id'))
    return { accepted: true };
  if (!response.ok)
    throw new ProviderError(
      response.status,
      response.status >= 500,
      `LINE API ตอบกลับ ${response.status}`,
    );
  const result = await response.text();
  return result ? JSON.parse(result) : {};
}
export async function gemini(
  config: Config,
  prompt: string,
  system: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (config.demo || !config.geminiKey || !config.geminiModel)
    throw new AppError(503, 'ยังไม่ได้เชื่อมต่อโมเดล AI');
  const response = await fetcher(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiKey },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
      }),
    },
  );
  if (!response.ok) throw new AppError(503, 'โมเดล AI ไม่พร้อมใช้งาน');
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new AppError(503, 'โมเดลไม่ส่งคำตอบกลับมา');
  return text.slice(0, 4500);
}
export async function embed(
  config: Config,
  text: string,
  fetcher: Fetcher = fetch,
): Promise<number[] | null> {
  if (config.demo || !config.geminiKey || !config.embeddingModel) return null;
  const response = await fetcher(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.embeddingModel)}:embedContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiKey },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: `models/${config.embeddingModel}`,
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    },
  );
  if (!response.ok) throw new AppError(503, 'สร้าง embedding ไม่สำเร็จ');
  const data = (await response.json()) as { embedding?: { values?: number[] } };
  const values = data.embedding?.values;
  if (!values || values.length !== 768 || values.some((v) => !Number.isFinite(v)))
    throw new AppError(503, 'รูปแบบ embedding ไม่ถูกต้อง');
  return values;
}
