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
        hint: 'LINE User ID เริ่มด้วย U ไม่ใช่ LINE ID ที่ใช้ค้นหาเพื่อน',
      },
      {
        key: 'LINE_SUPERVISOR_ALERT_USER_ID',
        label: 'ผู้รับแจ้งเคสเกิน 5 นาที',
        hint: 'LINE User ID ของหัวหน้า',
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
    title: 'Gemini',
    description: 'Google AI Studio → API Keys',
    fields: [
      { key: 'GEMINI_API_KEY', label: 'API key', secret: true },
      {
        key: 'GEMINI_MODEL',
        label: 'โมเดลคำตอบ',
        hint: 'Model ID ที่รองรับ generateContent ไม่ใส่ models/ นำหน้า',
      },
      {
        key: 'GEMINI_EMBEDDING_MODEL',
        label: 'โมเดลค้นหาความหมาย',
        hint: 'รองรับ embedContent และ 768 มิติ; เว้นว่างได้',
      },
      {
        key: 'AI_ANALYTICS_ENABLED',
        label: 'วิเคราะห์บทสนทนา',
        options: ['false', 'true'],
        hint: 'เมื่อเปิด ระบบส่งบริบทที่ปกปิดข้อมูลเบื้องต้นให้ Gemini',
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
