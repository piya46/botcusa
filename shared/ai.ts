export const aiBehaviorOptions = {
  mode: {
    label: 'ขอบเขตการตอบ',
    options: {
      conversational: 'พูดคุยและถามรายละเอียดเบื้องต้น',
      knowledge_only: 'ตอบเฉพาะฐานความรู้',
    },
  },
  tone: { label: 'บุคลิก', options: { friendly: 'เป็นกันเอง สุภาพ', formal: 'สุภาพ เป็นทางการ' } },
  language: { label: 'ภาษา', options: { auto: 'ตามภาษาผู้ใช้', th: 'ไทย', en: 'อังกฤษ' } },
  length: {
    label: 'ความยาว',
    options: {
      short: 'สั้น กระชับ',
      balanced: 'พอดี พร้อมรายละเอียดสำคัญ',
      detailed: 'ละเอียดเมื่อจำเป็น',
    },
  },
  format: {
    label: 'รูปแบบคำตอบ',
    options: { natural: 'ข้อความสนทนา', bullets: 'หัวข้อสั้น ๆ', steps: 'เรียงขั้นตอน' },
  },
} as const;
export interface AiBehavior {
  mode: 'conversational' | 'knowledge_only';
  tone: 'friendly' | 'formal';
  language: 'auto' | 'th' | 'en';
  length: 'short' | 'balanced' | 'detailed';
  format: 'natural' | 'bullets' | 'steps';
  clarificationLimit: number;
  useApprovedExamples: boolean;
}
export const defaultAiBehavior: AiBehavior = {
  mode: 'conversational',
  tone: 'friendly',
  language: 'auto',
  length: 'short',
  format: 'natural',
  clarificationLimit: 2,
  useApprovedExamples: true,
};
