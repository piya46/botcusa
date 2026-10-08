import type { Config } from './config.js';
import { vertexAccessToken, vertexConfigured, type VertexTokenProvider } from './vertex-auth.js';
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
  timeoutMs = 12_000,
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
      signal: AbortSignal.timeout(timeoutMs),
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
export async function showLineLoading(config: Config, chatId: string, fetcher: Fetcher = fetch) {
  if (
    !config.lineLoadingEnabled ||
    !/^U[0-9a-f]{32}$/.test(chatId) ||
    (!config.demo && !config.lineToken)
  )
    return 'SKIPPED';
  try {
    // Cosmetic only: a failed/slow loading request must not prevent a real answer.
    await lineRequest(
      config,
      '/v2/bot/chat/loading/start',
      { chatId, loadingSeconds: config.lineLoadingSeconds },
      undefined,
      fetcher,
      'POST',
      1500,
    );
    return config.demo ? 'SIMULATED' : 'ACCEPTED';
  } catch {
    return 'FAILED';
  }
}
export async function generateText(
  config: Config,
  prompt: string,
  system: string,
  fetcher: Fetcher = fetch,
  jsonSchema?: Record<string, unknown>,
  tokenProvider: VertexTokenProvider = vertexAccessToken,
): Promise<string> {
  if (!vertexConfigured(config)) throw new AppError(503, 'ยังไม่ได้เชื่อมต่อโมเดล AI');
  const response = await fetcher(
    vertexUrl(config, config.vertexModel, config.vertexLocation, 'generateContent'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await tokenProvider(config)}`,
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: jsonSchema ? 4000 : 800,
          ...(jsonSchema
            ? {
                responseMimeType: 'application/json',
                responseSchema: vertexResponseSchema(jsonSchema),
              }
            : {}),
        },
      }),
    },
  );
  if (!response.ok)
    throw new AppError(
      503,
      `Vertex AI ตอบ HTTP ${response.status} ตรวจโมเดล location สิทธิ์ และโควตา`,
    );
  const data = (await response.json()) as {
    candidates?: {
      finishReason?: string;
      content?: { parts?: { text?: string; thought?: boolean }[] };
    }[];
  };
  const text = data.candidates?.[0]?.content?.parts
    ?.filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (data.candidates?.[0]?.finishReason && data.candidates[0].finishReason !== 'STOP')
    throw new AppError(503, 'โมเดลไม่ส่งคำตอบที่สมบูรณ์');
  if (!text) throw new AppError(503, 'โมเดลไม่ส่งคำตอบกลับมา');
  if (jsonSchema) {
    if (data.candidates?.[0]?.finishReason !== 'STOP' || text.length > 20000)
      throw new AppError(503, 'ผลวิเคราะห์ไม่ครบถ้วน');
    return text;
  }
  return text.slice(0, 4500);
}
export async function embed(
  config: Config,
  text: string,
  fetcher: Fetcher = fetch,
  task: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' = 'RETRIEVAL_QUERY',
  tokenProvider: VertexTokenProvider = vertexAccessToken,
): Promise<number[] | null> {
  if (config.demo || !config.vertexProject || !config.embeddingModel) return null;
  const response = await fetcher(
    vertexUrl(config, config.embeddingModel, config.vertexEmbeddingLocation, 'predict'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await tokenProvider(config)}`,
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        instances: [{ content: text, task_type: task }],
        parameters: { outputDimensionality: 768, autoTruncate: true },
      }),
    },
  );
  if (!response.ok) throw new AppError(503, 'สร้าง embedding ไม่สำเร็จ');
  const data = (await response.json()) as {
    predictions?: { embeddings?: { values?: number[] } }[];
  };
  const values = data.predictions?.[0]?.embeddings?.values;
  if (!values || values.length !== 768 || values.some((v) => !Number.isFinite(v)))
    throw new AppError(503, 'รูปแบบ embedding ไม่ถูกต้อง');
  return values;
}

export function vertexUrl(config: Config, model: string, location: string, method: string) {
  const host =
    location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(config.vertexProject)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:${method}`;
}
// Vertex responseSchema is a subset of JSON Schema; keep strict validation on our server too.
function vertexResponseSchema(schema: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of [
    'type',
    'description',
    'enum',
    'required',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
  ])
    if (schema[key] !== undefined)
      result[key] = key === 'type' ? String(schema[key]).toUpperCase() : schema[key];
  if (schema.properties)
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        vertexResponseSchema(value as Record<string, any>),
      ]),
    );
  if (schema.items) result.items = vertexResponseSchema(schema.items);
  return result;
}
