// CUSA returns these application-scoped role codes. Authorization is defined here and on API routes.
export const staffRoles = [
  {
    code: 'admin',
    role: 'ADMIN',
    label: 'ผู้ดูแลระบบ',
    description: 'ดูแลงานบริการ ตั้งค่า หน่วยงาน บรอดแคสต์ และอนุมัติข้อมูล',
  },
  {
    code: 'reviewer',
    role: 'REVIEWER',
    label: 'ผู้ตรวจทาน',
    description: 'อ่านบทสนทนา ตรวจและอนุมัติฐานความรู้กับชุดข้อมูล AI',
  },
  {
    code: 'agent',
    role: 'AGENT',
    label: 'เจ้าหน้าที่',
    description: 'รับ ตอบ โอน ปิดเคส และเตรียมร่างความรู้กับตัวอย่างฝึก',
  },
] as const;
export function staffRole(codes: string[]) {
  return staffRoles.find((entry) => codes.includes(entry.code))?.role;
}
