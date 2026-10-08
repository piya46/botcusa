export const installGroups = [
  {
    title: 'LINE Messaging API',
    description: 'LINE Developers → Messaging API channel',
    fields: [
      {
        key: 'LINE_CHANNEL_SECRET',
        label: 'Channel secret',
        secret: true,
        hint: 'Basic settings → Channel secret',
      },
      {
        key: 'LINE_CHANNEL_ACCESS_TOKEN',
        label: 'Channel access token',
        secret: true,
        hint: 'Messaging API → Channel access token (long-lived)',
      },
      {
        key: 'LINE_AGENT_ALERT_USER_ID',
        label: 'ผู้รับแจ้งเคสส่วนกลาง',
        hint: 'Group ID ขึ้นต้น C หรือ User ID ขึ้นต้น U; ต้องเชิญ OA เข้ากลุ่มก่อน',
      },
      {
        key: 'LINE_SUPERVISOR_ALERT_USER_ID',
        label: 'ผู้รับแจ้งเคสเกิน 5 นาที',
        hint: 'Group ID ขึ้นต้น C หรือ User ID ของหัวหน้าขึ้นต้น U',
      },
      { key: 'LINE_LOADING_ENABLED', label: 'แสดงกำลังตอบ', options: ['true', 'false'] },
      {
        key: 'LINE_LOADING_SECONDS',
        label: 'เวลาที่แสดง (วินาที)',
        hint: '5–60 เพิ่มทีละ 5',
        numeric: true,
      },
    ],
  },
  {
    title: 'LINE Login และ Rich Menu',
    description: 'ใช้ Provider เดียวกับ Messaging API',
    fields: [
      {
        key: 'LINE_LOGIN_CHANNEL_ID',
        label: 'LINE Login Channel ID',
        hint: 'Basic settings ของ LINE Login channel',
      },
      { key: 'LIFF_ID', label: 'LIFF ID', hint: 'แท็บ LIFF → แอปที่ตั้ง Endpoint เป็น /connect' },
      {
        key: 'LINE_MEMBER_RICH_MENU_ID',
        label: 'Rich Menu สมาชิก',
        hint: 'richMenuId ของเมนูที่สร้างผ่าน Messaging API',
      },
      {
        key: 'LINE_GUEST_RICH_MENU_ID',
        label: 'Rich Menu ผู้เยี่ยมชม',
        hint: 'เว้นว่างได้ หากยังไม่มีเมนู',
      },
    ],
  },
  {
    title: 'Vertex AI',
    description: 'Google Cloud → Vertex AI และ Service Account',
    fields: [
      {
        key: 'GOOGLE_CLOUD_PROJECT',
        label: 'Google Cloud Project ID',
        hint: 'Project ID จากหน้า Dashboard ไม่ใช่ Project name',
      },
      {
        key: 'GOOGLE_CLOUD_LOCATION',
        label: 'Location โมเดลคำตอบ',
        hint: 'global หรือ region ที่โมเดลรองรับ',
      },
      {
        key: 'GOOGLE_APPLICATION_CREDENTIALS',
        label: 'ไฟล์ Service Account บนโฮสต์',
        hint: 'อัปโหลด JSON ไว้นอก public แล้วระบุ path เช่น .secrets/vertex-service-account.json',
      },
      {
        key: 'VERTEX_AI_MODEL',
        label: 'โมเดลคำตอบ',
        hint: 'Model ID ที่รองรับ generateContent ไม่ใส่ models/ นำหน้า',
      },
      {
        key: 'VERTEX_AI_EMBEDDING_MODEL',
        label: 'โมเดลค้นหาความหมาย',
        hint: 'gemini-embedding-001 หรือ text-multilingual-embedding-002; เว้นว่างได้',
      },
      {
        key: 'VERTEX_AI_EMBEDDING_LOCATION',
        label: 'Location ค้นหาความหมาย',
        hint: 'เช่น us-central1 แยกจากโมเดลคำตอบได้',
      },
      {
        key: 'AI_ANALYTICS_ENABLED',
        label: 'วิเคราะห์บทสนทนา',
        options: ['false', 'true'],
        hint: 'เมื่อเปิด ระบบส่งบริบทที่ปกปิดข้อมูลเบื้องต้นให้ Vertex AI',
      },
    ],
  },
  {
    title: 'อายุข้อมูล',
    description: 'กำหนดตามนโยบายองค์กร ตั้งได้ 1–3650 วัน',
    fields: [
      { key: 'CHAT_RETENTION_DAYS', label: 'เก็บบทสนทนา (วัน)', numeric: true },
      { key: 'DATASET_RETENTION_DAYS', label: 'เก็บชุดข้อมูลฝึก (วัน)', numeric: true },
    ],
  },
] satisfies {
  title: string;
  description: string;
  fields: {
    key: string;
    label: string;
    hint?: string;
    secret?: boolean;
    numeric?: boolean;
    options?: string[];
  }[];
}[];

export interface InstallInput {
  origin: string;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    tls: boolean;
    caFile: string;
  };
  services: Record<string, string>;
}
