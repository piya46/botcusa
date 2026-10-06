# CUSA Member Desk

ระบบดูแลสมาชิกผ่าน LINE พร้อม Agent Inbox และกระบวนการเตรียมข้อมูลสำหรับปรับปรุง AI

## ทดลองใช้งาน

ต้องมี Node.js 22.12 ขึ้นไป

```bash
npm ci
npm run dev
```

เปิด **http://localhost:5180** — API อยู่ที่ `http://127.0.0.1:3001`

ค่าเริ่มต้นเป็น **demo** ใช้สมาชิกสมมติและจำลองการส่ง LINE ทุกครั้ง ข้อมูลเก็บจริงใน `.data/postgres` ด้วย embedded PostgreSQL (PGlite) และไฟล์แนบเข้ารหัสอยู่ใน `.data/attachments` ปิดและเปิดโปรแกรมใหม่แล้วข้อมูลยังอยู่ ห้ามเปิดโปรเซสสองตัวบนโฟลเดอร์ PGlite เดียวกัน

พื้นที่ทดลองมีสามบัญชี สลับที่มุมซ้ายล่าง:

- **พิมพ์ชนก / ADMIN:** รับงาน ตอบแชต และจัดเตรียมข้อมูล
- **ธนกฤต / REVIEWER:** ตรวจความรู้และอนุมัติชุดข้อมูล
- **นลิน / AGENT:** เจ้าหน้าที่อีกคนสำหรับทดลองรับงานและสิทธิ์

## สิ่งที่ใช้งานได้ในรุ่นนี้

- Dashboard แสดงข้อมูลจริงจากฐานข้อมูล พร้อมแนวโน้มรายวันตามเวลา Asia/Bangkok
- Inbox: ค้นหา/กรอง รับเคสแบบ atomic ตอบข้อความ ส่งภาพ PNG/JPEG ไม่เกิน 1 MB บันทึกภายใน ปิดเคสพร้อมผลการดูแล และดาวน์โหลด transcript JSON
- Tickets: โอนเคสไปหน่วยงานและผู้รับผิดชอบ ระบุเหตุผล แจ้งเตือนผู้รับในระบบ รับงานต่อในเคสเดิม และเก็บเส้นทางการโอนพร้อมผู้รับงานแต่ละครั้ง
- ข้อความเจ้าหน้าที่และงานส่งถูกบันทึกใน transaction เดียวกันก่อนเรียก LINE ข้อความและไฟล์แนบเข้ารหัส AES-256-GCM
- LINE webhook ตรวจ HMAC จาก raw bytes บันทึกงานก่อนตอบ 200 กัน event ซ้ำ และประมวลผลผ่าน durable PostgreSQL queue
- รับข้อความและชนิดข้อมูล LINE รวมทั้ง payload ของข้อความที่เข้ารหัส; ดาวน์โหลดไฟล์แนบจาก LINE ไม่เกิน 20 MB และให้เจ้าหน้าที่ที่ล็อกอินเข้าถึง
- Reply เมื่อ token ยังใช้ได้; Push เมื่อไม่มี token ที่ใช้ได้ พร้อม retry key คงที่ การตอบ Reply ที่ไม่ทราบผลจะไม่ส่งซ้ำหรือเปลี่ยนไป Push อัตโนมัติ
- หยุดบอทหลังส่งต่อหรือรับเคส; เมื่อเคสปิดแล้ว ข้อความใหม่เริ่มเคสใหม่กับบอท
- AI ใช้ฉบับความรู้ที่อนุมัติแล้ว พร้อม keyword search ภาษาไทย และ pgvector เมื่อกำหนด embedding model หากไม่มีโมเดลใช้คำตอบทางการโดยตรง ถ้าข้อมูลไม่พอส่งต่อเจ้าหน้าที่
- Knowledge Base: ฉบับร่าง, ผู้ตรวจทานอีกคน, ประวัติเวอร์ชัน, ฉบับเผยแพร่ที่แยกจากฉบับกำลังแก้ไข
- Training Studio: เลือกคำตอบเจ้าหน้าที่ที่ส่งสำเร็จจากเคสแก้สำเร็จ รักษาบริบทข้อความ ปกปิดข้อมูลเบื้องต้น ตรวจ/แก้ไข อนุมัติโดยคนละคน และส่งออก JSONL
- Dataset snapshots มีเวอร์ชันและที่มาของข้อมูล แบ่ง train/validation/test ด้วย hash ของ conversation เพื่อไม่ให้เคสเดียวกันข้ามชุด
- รองรับ LINE unsend แม้ event ยกเลิกมาถึงก่อนข้อความต้นฉบับ ถอนเนื้อหา ไฟล์แนบ ตัวอย่าง และ snapshot ที่เกี่ยวข้อง
- สมาชิก: ดูสถานะผูกบัญชี ยกเลิกการผูก ระบุแท็กความสนใจ เปลี่ยน/ปลด Rich Menu รายคน พร้อมสถานะคำสั่งและกันงานเก่าเขียนทับคำสั่งล่าสุด
- Broadcast ข้อความ: ฉบับร่าง กลุ่ม all/members/guests กรองสังกัด บทบาท CUSA และแท็กความสนใจ นับผู้รับจากฐานข้อมูล ตรวจโควตาก่อนเข้าคิว ตั้งเวลาไทย แบ่งชุดไม่เกิน 500 ผู้รับ พร้อม retry key
- แจ้ง Supervisor เมื่อรอรับเคสเกิน 5 นาที หนึ่งครั้งต่อรอบส่งต่อ และยกเลิกงานแจ้งเตือนที่ล้าสมัยหลังโอนเคส
- รายงานเวลารับเคสเฉลี่ย/P90 สัดส่วนรับภายใน 5 นาที และจำนวนข้อความขาเข้าตามชั่วโมงเวลาไทย
- ตั้งค่า Prompt/นโยบายข้อมูล เพิ่มเจ้าหน้าที่ และ Audit Log
- LIFF/CUSA SSO ตาม OpenAPI **1.4.0** ที่ผู้ใช้ให้มา: [สัญญา API](docs/cusa-sso.openapi.json)

## ทดลองครบวงจร

1. เปิดกล่องข้อความ กด `+` เพื่อจำลองสมาชิกขอติดต่อเจ้าหน้าที่
2. เลือกเคส กด **รับเคสนี้** แล้วตอบ ข้อความแสดง **ส่งจำลองแล้ว** ใน demo
3. เพิ่มบันทึกภายในได้ บันทึกนี้ไม่ถูกส่งให้สมาชิกและไม่ถูกเลือกเป็นข้อมูลฝึก
4. กด **ปิดเคส** เลือกแก้ปัญหาแล้ว พร้อมสรุปผล
5. กด **สร้างตัวอย่างฝึก** ในแผงรายละเอียดเคส แล้วเปิดหน้า **ชุดข้อมูล AI**
6. ตรวจคำถาม/คำตอบและข้อมูลระบุตัวตน สลับเป็นธนกฤตเพื่ออนุมัติ ผู้สร้างหรือผู้แก้ไขอนุมัติตัวเองไม่ได้
7. สร้างเวอร์ชัน dataset และดาวน์โหลด JSONL ตาม split

### โอน Ticket เมื่อยังแก้ปัญหาไม่ได้

1. ผู้ดูแลเปิด **เคสและการส่งต่อ → จัดการหน่วยงาน** เพื่อเพิ่มทีมและเจ้าหน้าที่ สมาชิกทีมต้องเป็น AGENT หรือ ADMIN หน่วยงานบริการนี้แยกจากสังกัดศิษย์เก่าที่ได้จาก SSO
2. ผู้ดูแลเคสกด **โอนเคส** ใน Inbox หรือเลือก **ยังแก้ไขไม่สำเร็จ → โอนไปหน่วยงานที่เกี่ยวข้อง** ในหน้าปิดเคส
3. เลือกหน่วยงาน ระบุผู้รับผิดชอบหรือปล่อยให้เข้าคิวหน่วยงาน และเขียนเหตุผล/สิ่งที่ต้องดำเนินการต่อ
4. เคสเปลี่ยนเป็น **รอเจ้าหน้าที่** บอทยังคงหยุดตอบ เลขเคสและประวัติสนทนาเดิมคงอยู่ เหตุผลเห็นเฉพาะทีมงานและเก็บแบบเข้ารหัส
5. ผู้รับที่ระบุจะเห็นแจ้งเตือนที่กระดิ่ง หากส่งเข้าคิวทีม สมาชิกทีมทุกคนจะได้รับแจ้งเตือนในระบบ เปิดเคสแล้วกด **รับเคสนี้** ก่อนตอบ ผู้รับผิดชอบเดิมที่เป็น AGENT ไม่มีสิทธิ์ตอบแทรก ผู้ดูแลระบบยังมีสิทธิ์จัดการเคสเพื่อช่วยแก้งานค้าง
6. หน้า Tickets กรองหน่วยงาน สถานะ และ **งานของฉันและคิวทีม** ได้ ประวัติการโอนแสดงผู้ส่ง หน่วยงาน ผู้รับ เหตุผล และเวลารับงาน รวมอยู่ใน transcript ด้วย บริบทบทสนทนาจากเจ้าหน้าที่ทุกคนยังนำไปตรวจทานเป็นข้อมูลฝึกได้เมื่อปิดเคสสำเร็จ

Demo มี **งานบริการสมาชิก / พิมพ์ชนก** และ **งานระบบและบัญชี CUSA / นลิน** ให้ลองโอนและสลับบัญชีได้ การแจ้งเตือนโอนเคสเป็นการแจ้งเตือนภายในเว็บ ยังไม่มีการส่งอีเมลหรือ LINE รายบุคคลของเจ้าหน้าที่

### กลุ่มข่าวสารและ Rich Menu

ตัวกรองหลายค่าในกลุ่มเดียวใช้ OR; ตัวกรองคนละกลุ่มใช้ AND ผู้ที่บล็อก OA ไม่นับเป็นผู้รับ และผู้ที่ไม่ได้แบ่งปันสังกัด/บทบาทไม่เข้าเงื่อนไขนั้น ข้อมูล CUSA เป็น snapshot ครั้งที่ผูกบัญชี ส่วนแท็กความสนใจในรุ่นนี้ระบุโดยเจ้าหน้าที่ ไม่ได้อ้างว่า AI วิเคราะห์แล้ว จำนวนผู้รับจะตรวจใหม่เมื่อยืนยันและบันทึกรายชื่อคงที่สำหรับการตั้งเวลา/ส่งซ้ำ

หน้า **สมาชิก → จัดการสมาชิก** เลือก Rich Menu จากบัญชี LINE ที่เชื่อมต่อ หรือปลดเพื่อกลับไปใช้เมนูเริ่มต้นของ OA ได้ การเปลี่ยนเมนูไม่ให้สิทธิ์ CUSA เพิ่มและไม่เปลี่ยนตัวตนสมาชิก สถานะ “LINE รับคำสั่งแล้ว” แสดงผลรับ API เท่านั้น ไม่ยืนยันว่าเมนูปรากฏบนเครื่องสมาชิก; เงื่อนไขการแสดงเป็นไปตาม [LINE Rich Menu API](https://developers.line.biz/en/reference/messaging-api/nojs/#link-rich-menu-to-user)

## การเปิดใช้บริการจริง

คัดลอก `.env.example` เป็น `.env` และกำหนดค่าขององค์กรเอง **ห้ามเก็บ secrets ลง repository**

| ค่า | การใช้งาน |
| --- | --- |
| `APP_MODE=live` | ปิด demo login, mock send และการจำลองสมาชิกทั้งหมด |
| `DATABASE_URL` | PostgreSQL ที่มี extension pgvector |
| `DATA_ENCRYPTION_KEY` | base64 ของ 32 random bytes; สร้างด้วย `openssl rand -base64 32` และสำรองแยกอย่างปลอดภัย |
| `APP_ORIGIN` | HTTPS origin เช่น `https://bot.reunion.scicu-alumni.com` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | สร้างบัญชีผู้ดูแลครั้งแรก; รหัสผ่านอย่างน้อย 12 ตัวอักษร |
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | ลายเซ็น webhook และ Messaging API |
| `LINE_LOGIN_CHANNEL_ID`, `LIFF_ID` | LINE Login/LIFF ภายใต้ Provider เดียวกับ Messaging API เปิด scope `openid` |
| `LINE_MEMBER_RICH_MENU_ID`, `LINE_GUEST_RICH_MENU_ID` | เมนูหลังผูกบัญชีและหลังยกเลิกผูกบัญชี |
| `LINE_AGENT_ALERT_USER_ID` | ผู้รับแจ้งเตือนเคสหนึ่งคนใน LINE ต้องรับข้อความจาก OA ได้ |
| `LINE_SUPERVISOR_ALERT_USER_ID` | ผู้รับ LINE แจ้งเคสที่รอเกิน 5 นาที ควรเป็น Supervisor; ไม่กำหนดจะไม่ส่งการแจ้งเตือนนี้ใน live |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | โมเดลข้อความที่ยังเปิดให้บริการและผ่านการทดสอบกับข้อมูลขององค์กร |
| `GEMINI_EMBEDDING_MODEL` | โมเดลที่รองรับ embedding 768 มิติ; เว้นว่างเพื่อใช้ keyword retrieval |
| `CUSA_SSO_ORIGIN` | `https://sso.reunion.scicu-alumni.com` |
| `CUSA_CLIENT_ID`, `CUSA_API_KEY` | Application UUID และคีย์ฝั่ง Backend ที่มี `identity:read` |
| `CHAT_RETENTION_DAYS`, `DATASET_RETENTION_DAYS` | ค่าเริ่มต้น 180 วันทั้งคู่ |

ลงทะเบียน URL เหล่านี้กับผู้ให้บริการ:

```text
LINE webhook: https://bot.reunion.scicu-alumni.com/api/webhook
LIFF endpoint: https://bot.reunion.scicu-alumni.com/connect
CUSA callback: https://bot.reunion.scicu-alumni.com/api/auth/callback
```

เปิด webhook redelivery และกำหนดให้เจ้าหน้าที่ตอบผ่าน **Member Desk เท่านั้น** เพื่อเก็บบทสนทนาฝั่งเจ้าหน้าที่ครบถ้วน ตั้งค่าข้อความตอบอัตโนมัติใน OA Manager ให้ไม่ตอบแทรกผู้ช่วย

```bash
npm run build
npm start
```

เซิร์ฟเวอร์จะให้บริการเว็บและ API ภายใต้ origin เดียวกัน ใช้ reverse proxy สำหรับ HTTPS หน้า Node.js; API ตรวจ Origin ของคำขอแก้ไขข้อมูลและใช้ session cookie แบบ HttpOnly/Secure/SameSite ใน live mode

Worker ตรวจเคสเกินกำหนดทุกประมาณหนึ่งนาที จึงไม่ใช่การรับประกันส่งตรงนาทีที่ 5 เมื่อมีงานค้างหรือบริการภายนอกขัดข้อง การโอนเริ่มรอบรอรับใหม่และงานแจ้งเตือนรอบเก่าจะถูกข้าม รายงานเวลารับงานใช้รอบล่าสุดของแต่ละเคส นับเฉพาะเคสที่รับแล้ว ส่วนจำนวนเคสรอเกินกำหนดแสดงแยกต่างหาก

### รายละเอียด CUSA SSO

- เริ่มที่ `/api/sso/authorize` ไม่ใช้ URL `/login?auth=success&status=mfa_required` เป็นหลักฐานยืนยันตัวตน
- Backend ตรวจ LINE ID token กับ LINE แล้วเก็บ verified LINE user ID, state, PKCE verifier และ browser cookie ไว้ในธุรกรรมอายุ 10 นาที
- Authorization code ใช้ครั้งเดียว แลกด้วย JSON และ `X-API-Key` ตาม OpenAPI; ไม่เพิ่ม `client_id` ลง token body
- ตรวจ `token_type`, scope `identity:read`, `userinfo.aud` และ application-scoped roles; ฟิลด์ชื่อ/อีเมล/สังกัดอาจไม่มีหากผู้ใช้ไม่ได้อนุญาต
- code/state ใช้ครั้งเดียว ผูกกับ browser cookie และไม่ retry code เมื่อไม่ทราบผล
- token มีอายุสูงสุด 300 วินาที ไม่มี refresh token และไม่ถูกเก็บเป็นเซสชันระยะยาว
- รุ่นนี้ใช้ SSO เพื่อ **ผูกตัวตนสมาชิก** เท่านั้น บัญชีเจ้าหน้าที่ใช้การล็อกอินของ Member Desk แยกต่างหาก ข้อมูลสมาชิกที่แสดงเป็น snapshot ณ ครั้งที่ผูกล่าสุด ไม่ใช่หลักฐานสิทธิ์เข้าถึงบริการสำคัญ; หากเพิ่มบริการที่ต้องตรวจสิทธิ์ ต้อง reauthenticate/introspect ตาม OpenAPI (cache สูงสุด 5 วินาที)
- ระบบไม่เขียนเปลี่ยนนโยบาย Applications หรือ MFA ของ CUSA

### Docker / PostgreSQL

`compose.yaml` เตรียม PostgreSQL+pgvector และแอปสำหรับ live mode ตั้งค่า `.env` ให้ครบ รวม `POSTGRES_PASSWORD` ที่เป็น URL-safe เช่น random hex

```bash
docker compose up -d db
# เมื่อกำหนด credentials และ HTTPS reverse proxy แล้ว:
docker compose --profile live up -d --build app
```

แอปและ worker อยู่ใน process เดียว ต้องรันต่อเนื่องบน VM/VPS หรือโฮสต์ที่ให้ CPU ระหว่างไม่มี HTTP request อย่าใช้ background worker นี้บน Cloud Run แบบ CPU เฉพาะช่วง request โดยไม่มีการปรับ deployment

ไฟล์แนบปัจจุบันอยู่บน persistent local volume หากรันหลาย replica ต้องใช้ shared storage หรือเพิ่ม object-storage adapter ก่อน ข้อมูลข้อความใน production ใช้ PostgreSQL ส่วน media URL มีลายเซ็นและอายุหนึ่งชั่วโมงเพื่อให้ LINE ดาวน์โหลดภาพที่เจ้าหน้าที่ส่ง

ไฟล์ Docker เตรียมไว้แล้ว แต่ยังไม่ได้ทดสอบการรัน container บนเครื่องนี้ เพราะ Docker daemon ไม่ได้เปิดอยู่

## ข้อมูลฝึกและการเก็บรักษา

เปิด Training Studio ใน live mode หลังระบุเวอร์ชันประกาศการใช้ข้อมูลและวัตถุประสงค์ ผู้ตรวจทานต้องตรวจทั้งความถูกต้องและข้อมูลส่วนบุคคล การตรวจด้วย regex ช่วยลดข้อมูลเบื้องต้น แต่ไม่รับประกันตรวจชื่อ ที่อยู่ หรือข้อมูลระบุตัวตนในภาษาธรรมชาติได้ทั้งหมด

- ประวัติบริการเก็บต้นฉบับเข้ารหัส แยกจากข้อมูลฝึกที่ผ่าน masking และการตรวจคน
- JSONL เป็นรูปแบบกลาง `messages + metadata + split`; ยังไม่ใช่ตัวอัปโหลดฝึกอัตโนมัติของผู้ให้บริการใด ต้องเลือกโมเดลและแปลงให้ตรงสัญญาการฝึกของผู้ให้บริการ
- ตัวอย่างฝึกอัตโนมัติในรุ่นนี้เป็นข้อความ ไม่ดึงบันทึกภายใน ข้อความส่งล้มเหลว หรือภาพมาเป็นคำตอบฝึก
- ใช้สถานะ `ACCEPTED` หมายถึง LINE รับ API request ไม่ได้ยืนยันการส่งถึงเครื่องหรือการอ่านของสมาชิก
- การหมดอายุ/unsend จะถอนตัวอย่างที่เกี่ยวข้องและทำให้ snapshot นั้นดาวน์โหลดไม่ได้อีก การถอนนี้ไม่สามารถเรียกคืนไฟล์ที่ผู้ใช้ดาวน์โหลดออกไปแล้วหรือย้อนการฝึกโมเดลภายนอกได้
- ต้องสำรอง PostgreSQL, `.data/attachments` และ encryption key ให้สัมพันธ์กัน พร้อมกำหนดการลบข้อมูลใน backup ตามนโยบายขององค์กร การทำลาย key ทำให้ข้อมูลเข้ารหัสเดิมอ่านไม่ได้

## การทดสอบ

```bash
npm run typecheck
npm test
npm run build
# เปิด npm run dev ในอีก terminal ก่อน:
npm run test:e2e
```

API tests ใช้ PostgreSQL engine ใน PGlite และ mock เฉพาะการเรียกผู้ให้บริการ ครอบคลุม raw signature, duplicate webhook, atomic claim, authorization, durable outbox, Reply timeout, Push retry, training approvals, source deletion, draft isolation และ CUSA contract

Browser tests ใช้ Chrome ที่ติดตั้งบน macOS และบันทึกภาพลง `artifacts/`; แก้ `playwright.config.ts` ให้ใช้ browser/channel ของเครื่องอื่นได้ Tests สร้างเฉพาะข้อมูลสมมติใน demo workspace

## ขอบเขตที่ยังไม่ได้เปิดใช้

รุ่นนี้เน้น Agent Inbox และข้อมูลสำหรับ tuning ที่ตกลงให้เป็นแกนหลัก: ยังไม่มี semantic answer cache, PDF/OCR ingestion, AI สร้าง Flex Message, AI sentiment/post-session analytics หรือการฝึกโมเดลจริงอัตโนมัติ Analytics ที่แสดงเป็นข้อมูลเคสจากฐานข้อมูล ไม่มีการจำลองผล sentiment หรืออัตราความแม่นยำ

การสรุปความสนใจด้วย AI ยังต้องพัฒนาต่อ ระบบคิวและเซสชันรุ่นนี้ใช้ PostgreSQL แทน Redis; เป้าหมายเวลา AI ตอบไม่เกิน 3 วินาทีและ uptime ยังต้องวัดบนระบบที่ติดตั้งจริง

การเชื่อม LINE, Google Gemini และ CUSA จริงต้องทดสอบกับ credentials และบัญชีขององค์กรก่อนเปิดบริการ ขณะพัฒนาทดสอบสัญญา CUSA จาก OpenAPI ที่แนบมา ไม่ได้เข้าสู่บัญชีหรือส่งข้อความถึงบุคคลจริง

## โครงสร้าง

```text
src/                    React UI และ CSS responsive
server/app.ts           HTTP API, auth, role checks, validation
server/conversations.ts Case transitions และข้อความเจ้าหน้าที่
server/tickets.ts        หน่วยงาน การโอนเคส ประวัติ และการแจ้งเตือนผู้รับ
server/audiences.ts      เงื่อนไขกลุ่มเป้าหมายที่ใช้ร่วมกันระหว่าง preview และส่งจริง
server/rich-menus.ts     รายการเมนูและคิวเปลี่ยนเมนูแบบมีเวอร์ชัน
server/stats.ts          เวลารับเคสและสถิติตามชั่วโมงเวลาไทย
server/worker.ts         Durable queue, LINE, RAG และ retention
server/training.ts       Dataset review, versioning, split และ retraction
server/sso.ts            LIFF verification + CUSA PKCE
server/db.ts            PostgreSQL / PGlite adapters
server/schema.ts        SQL schema initialization
server/security.ts      Encryption, masking, password hashing, signatures
shared/                 Types ระหว่าง UI และ API
tests/                  API tests และ browser workflow
docs/cusa-sso.openapi.json สัญญา API จากผู้ใช้
```
