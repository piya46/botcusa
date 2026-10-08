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
    const key = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (action === 'rich-menus' && !key)
      throw new Error('กรอก LINE_CHANNEL_ACCESS_TOKEN ใน .env ก่อน');
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
      console.table([
        {
          purpose: 'ตอบคำถาม / วิเคราะห์',
          model: process.env.VERTEX_AI_MODEL || '(ยังไม่ตั้ง)',
          location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
        },
        {
          purpose: 'ค้นหาความหมาย',
          model: process.env.VERTEX_AI_EMBEDDING_MODEL || '(ใช้คำสำคัญ)',
          location: process.env.VERTEX_AI_EMBEDDING_LOCATION || 'us-central1',
        },
      ]);
      console.log('ค่าที่ตั้งไว้ ไม่ใช่ผลตรวจสิทธิ์หรือรายชื่อโมเดลในบัญชี');
      console.log('เลือกโมเดลใน Google Cloud → Vertex AI → Model Garden');
      console.log('https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'อ่านรายการไม่สำเร็จ');
    process.exitCode = 1;
  }
}
