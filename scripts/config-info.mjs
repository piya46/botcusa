#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];
if (!['models', 'rich-menus'].includes(action)) {
  console.log(
    'npm run config:models | npm run config:rich-menus\nReads provider metadata using .env; does not send messages or generate content.',
  );
} else {
  try {
    if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
    const key = process.env[action === 'models' ? 'GEMINI_API_KEY' : 'LINE_CHANNEL_ACCESS_TOKEN'];
    if (!key)
      throw new Error(
        action === 'models'
          ? 'กรอก GEMINI_API_KEY ใน .env ก่อน'
          : 'กรอก LINE_CHANNEL_ACCESS_TOKEN ใน .env ก่อน',
      );
    if (action === 'rich-menus') {
      const response = await fetch('https://api.line.me/v2/bot/richmenu/list', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`LINE ตอบ HTTP ${response.status}; ตรวจ token และ OA`);
      const data = await response.json();
      console.table(
        (data.richmenus ?? []).map((menu) => ({ name: menu.name, id: menu.richMenuId })),
      );
    } else {
      let next = '',
        pages = 0;
      do {
        const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
        url.searchParams.set('pageSize', '1000');
        if (next) url.searchParams.set('pageToken', next);
        const response = await fetch(url, {
          headers: { 'x-goog-api-key': key },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          throw new Error(`Gemini ตอบ HTTP ${response.status}; ตรวจ API key, สิทธิ์ และโควตา`);
        const data = await response.json();
        console.table(
          (data.models ?? [])
            .filter((model) =>
              (model.supportedGenerationMethods ?? []).some((method) =>
                ['generateContent', 'embedContent'].includes(method),
              ),
            )
            .map((model) => ({
              id: model.name.replace(/^models\//, ''),
              methods: (model.supportedGenerationMethods ?? []).join(', '),
            })),
        );
        next = data.nextPageToken ?? '';
        if (++pages >= 20 && next)
          throw new Error('รายการโมเดลเกินขอบเขต โปรดตรวจใน Google AI Studio');
      } while (next);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'อ่านรายการไม่สำเร็จ');
    process.exitCode = 1;
  }
}
