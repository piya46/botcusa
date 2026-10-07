# ติดตั้งบน Hostatom / Plesk Shared Hosting

สำหรับแพ็กเกจ **Node.js + MySQL/MariaDB ที่ไม่มี PostgreSQL และ Scheduled Tasks** มีหน้าติดตั้ง **`/install`** เตรียมด้วยเมนู **Run Script → install:web** ไม่ต้องใช้ root, Docker หรือ pgvector

ที่มาของค่าและขั้นตอนกรอกทุกตัวอยู่ใน [คู่มือ .env แบบละเอียด](ENVIRONMENT.md)

## ตรวจแพ็กเกจโฮสต์ก่อน

- Linux + Node.js **22.12 ขึ้นไป** และ npm
- **MySQL 8.0.17+ หรือ MariaDB 10.6+**, ตาราง InnoDB และผู้ใช้ฐานข้อมูลที่สร้าง/แก้ตารางและ index ได้
- โดเมน HTTPS และพื้นที่เขียนไฟล์ถาวรสำหรับ `.data`
- อนุญาต outbound HTTPS ไป LINE, Gemini และ CUSA SSO

ตรวจรุ่นฐานข้อมูลใน phpMyAdmin ด้วย `SELECT VERSION();` ตัวติดตั้งตรวจรุ่นด้วย ระบบใช้ transaction/row lock สำหรับคิวงาน และเก็บ embedding เป็น JSON ค้นหาความใกล้เคียงในแอป ไม่ต้องลง extension และไม่ต้องมีสิทธิ์สร้าง trigger

## 1. อัปโหลด

อัปโหลดโปรเจกต์เข้าโฟลเดอร์แอป เช่น `cusa` ภายในพื้นที่โดเมน โดยไม่ส่ง `node_modules`, `.data`, `.env` จากเครื่องทดลอง หรือไฟล์ทดสอบที่มีข้อมูลจริง

โครงสร้างที่ใช้:

```text
cusa/                 Application Root
  app.cjs             Startup File
  install.mjs         ตัวติดตั้ง
  install.sh          ตัวเรียกผ่าน SSH (ถ้ามี)
  public/             Document Root — ห้ามตั้งเป็นโฟลเดอร์ cusa ทั้งก้อน
  .env                ค่าจริงและ secrets สร้างบนเซิร์ฟเวอร์
  .data/              ไฟล์เข้ารหัส อยู่นอก Document Root
  .setup/             รหัสติดตั้งและสถานะการติดตั้ง อยู่นอก Document Root
```

ตั้ง **Document Root = cusa/public** และ **Application Root = cusa** ตั้งแต่แรก เพื่อไม่ให้เว็บเซิร์ฟเวอร์เสิร์ฟ `.env`, ฐานข้อมูล หรือซอร์สโค้ดเป็นไฟล์สาธารณะ หน้าเว็บจาก `dist` จะให้บริการผ่านแอป Fastify

## 2. ติดตั้งผ่านหน้าจอ (แนะนำ)

1. สร้างฐานข้อมูลเปล่าและ database user ใน **Plesk → Databases** จด host/port, ชื่อเต็มรวม prefix และรหัสผ่าน
2. ไป **Node.js** เลือก Node 22.12+ ตั้ง Startup File เป็น **app.cjs**
3. รัน **Run Script → install:web** ตัวติดตั้งเตรียม `.env` ส่วนพื้นฐาน ลง dependencies และ build เว็บให้ก่อน ยังไม่เชื่อมฐานข้อมูลหรือส่งข้อความ LINE
4. **Restart App** แล้วเข้า **`https://โดเมนของคุณ/install`**
5. เปิดไฟล์ **`.setup/access.key`** จาก File Manager แล้วกรอกรหัสในหน้าเว็บ ถ้าไม่เห็นโฟลเดอร์ ให้เปิดแสดงไฟล์ซ่อน
6. กรอกโดเมนและข้อมูล CUSA SSO → ฐานข้อมูล → บริการเสริม → กดติดตั้ง
7. เมื่อสำเร็จ **Restart App** อีกครั้ง แล้วเข้าหน้า `/admin/overview` ด้วย CUSA SSO ที่มีบทบาท `admin` ของแอปนี้

ระบบประกอบ `DATABASE_URL` ให้เองเมื่อกรอกส่วนต่าง ๆ ผ่านหน้าจอ จึงไม่ต้อง URL-encode password ด้วยมือ การตั้ง LINE/Gemini ข้ามแล้วเติมภายหลังได้ ส่วน CUSA SSO ต้องพร้อมสำหรับเจ้าหน้าที่ `/install` จะปิดเมื่อระบบติดตั้งแล้วและไม่ใช้สำหรับรีเซ็ตรหัสหรือเปลี่ยนฐานข้อมูลของระบบเดิม

ถ้า build เกิน RAM ของโฮสต์ ให้ build บนเครื่องก่อนและอัปโหลด `dist` กับ `dist-server` แล้วรัน `install:web` พร้อม argument `--skip-build` โฮสต์ยังต้องลง dependencies เพื่อรันแอป

## ทางเลือก: ตั้งผ่านไฟล์และคำสั่ง

ไป **Databases → Add Database** ใน Plesk สร้างฐานข้อมูลเปล่าและผู้ใช้เฉพาะแอปนี้ จดชื่อฐานข้อมูลและผู้ใช้แบบเต็มที่รวม prefix ของ subscription พร้อม host/port และรหัสผ่าน ตัวติดตั้งสร้างตารางให้ แต่ไม่สร้างฐานข้อมูลหรือบัญชี Plesk

ที่ **Websites & Domains → Node.js** เลือก Node.js 22.12+ แล้วใช้ **Run Script → install:plesk**

ครั้งแรกจะสร้าง `.env` สิทธิ์ 600 พร้อม encryption key โดยไม่แสดง secrets ใน log เปิดไฟล์ด้วย Plesk File Manager แล้วเติม:

```dotenv
APP_ORIGIN=https://bot.your-domain.com
DATABASE_URL="mysql://DB_USER:URL_ENCODED_PASSWORD@DB_HOST:3306/DB_NAME"
WORKER_MODE=opportunistic
CUSA_SSO_ORIGIN=https://sso.reunion.scicu-alumni.com
CUSA_CLIENT_ID=APPLICATION_UUID_FROM_CUSA
CUSA_API_KEY=BACKEND_API_KEY_FROM_CUSA
```

ใช้ host/port ที่ Plesk แจ้ง ไม่เดาว่าเป็น localhost เสมอ และ percent-encode รหัสผ่านใน URL หากมีอักขระพิเศษ ดูตัวอย่างใน [คู่มือ .env](ENVIRONMENT.md) ถ้าฐานข้อมูลใช้ TLS ให้เพิ่ม `?ssl=true` และตั้ง `MYSQL_SSL_CA` เมื่อมี CA เฉพาะ

เก็บ `DATA_ENCRYPTION_KEY` ไว้ชุดเดิมตลอด เจ้าหน้าที่ใช้ CUSA SSO เท่านั้น ให้ CUSA ลงทะเบียน callback `/api/auth/sso/callback` และสร้างบทบาท `admin`, `agent`, `reviewer` ของ application นี้ API key ต้องมี `identity:read`, `token:introspect` และ `token:revoke` ไม่ต้องตั้งรหัสผู้ดูแลในแอป ดูตารางสิทธิ์ใน [คู่มือ .env](ENVIRONMENT.md#9-cusa-sso--ขอจากผู้ดูแลระบบ-cusa)

ถ้ามี SSH ใช้คำสั่งแทนได้:

```sh
sh install.sh --init
# แก้ .env แล้ว
sh install.sh
```

### ติดตั้งและเริ่มแอปด้วยไฟล์

รัน **install:plesk** อีกครั้ง ตัวติดตั้งจะตรวจค่า → `npm ci --include=dev` → build → ตรวจรุ่น/เชื่อมต่อ MySQL/MariaDB → สร้างตารางและการตั้งค่าเริ่มต้น การติดตั้งไม่เริ่ม worker และไม่ส่ง LINE

ตั้งค่าใน Plesk:

| รายการ | ค่า |
| --- | --- |
| Application mode | Production |
| Application Root | โฟลเดอร์ `cusa` |
| Document Root | `cusa/public` |
| Application Startup File | `app.cjs` |

กด **Enable Node.js / Restart App** แล้วตรวจ `/api/health` ว่าตอบ HTTP 200 จากนั้นเปิด `/admin/overview` บนโดเมนจริง ต้องเห็นหน้าเข้าสู่ระบบ ไม่มีปุ่มสลับบัญชีทดลอง ไม่ต้องเปิดพอร์ต 3001 สู่ภายนอก เพราะ Passenger จัดการการรับ HTTP ให้

ถ้าโฮสต์จำกัด RAM จน build ไม่ผ่าน ให้ build บนเครื่องที่รองรับก่อน แล้วอัปโหลด `dist` และ `dist-server` ด้วย จากนั้นรัน **install:plesk** พร้อม argument `--skip-build` ตัวติดตั้งยังลง dependencies และตรวจฐานข้อมูล

## 3. งานเบื้องหลังโดยไม่ใช้ Scheduled Tasks

ตั้ง `WORKER_MODE=opportunistic` สำหรับโฮสต์นี้:

- เมื่อแอปเริ่ม หรือได้รับ HTTP เช่น LINE webhook/หน้าเจ้าหน้าที่ จะปลุก worker ทันที
- ระหว่าง process ทำงาน worker ตรวจคิวต่อเนื่อง คิวและสถานะส่งเก็บใน MySQL/MariaDB
- ถ้าโฮสต์หยุด process คิวไม่หาย เมื่อมี request ถัดไป แอปจะทำงานที่ถึงกำหนดต่อ
- งาน broadcast ที่ตั้งเวลา, แจ้ง Supervisor หลังรอ 5 นาที, retry และลบข้อมูลตามอายุ **อาจล่าช้าตลอดช่วงที่แอปพัก** หน้าเว็บแสดงข้อจำกัดนี้ Node timer ไม่สามารถปลุก process ที่หยุดอยู่ได้

ไม่ต้องตั้ง `cron.cjs` บนแพ็กเกจนี้ LINE ขาเข้าช่วยปลุกแอป แต่อาจมีเวลาเริ่มแอปหรือคิวค้าง หากโฮสต์จำกัดการทำงานหลังตอบ HTTP มาก ต้องทดสอบกับโฮสต์จริง

ถ้าต้องส่งตามเวลาแม้ไม่มี request เลย ต้องมีตัวเรียก HTTPS ภายนอกหรือพื้นที่รัน worker ต่อเนื่องเพิ่มเติม รุ่นนี้ไม่ได้สมัครหรือเปิดบริการภายนอกให้ และไม่รับประกัน SLA บน shared hosting

## 4. เชื่อมบริการ

เติม LINE/Gemini/CUSA ใน `.env` แล้ว **Restart App**:

- LINE webhook: `https://bot.your-domain.com/api/webhook`
- LIFF endpoint: `https://bot.your-domain.com/connect`
- CUSA callback: `https://bot.your-domain.com/api/auth/callback`
- เจ้าหน้าที่: หน้า **ตั้งค่าระบบ → LINE และการเชื่อมต่อ → ตั้งค่า LINE**
- Loading: `LINE_LOADING_ENABLED=true`, `LINE_LOADING_SECONDS=30`

ทดสอบด้วยบัญชีองค์กร: รับข้อความ → เห็น loading → บอทตอบ → รับเคส → โอนเคส → ผู้รับได้รับแจ้งเตือน LINE และเปิดเคสได้ จากนั้นปล่อยเว็บว่างแล้วส่ง LINE ใหม่ ตรวจว่างานค้างกลับมาทำงาน หน้า Settings แสดงชนิดฐานข้อมูลและเวลาทำงานล่าสุด การทดสอบใช้ MariaDB ชั่วคราวในเครื่องและผู้ให้บริการจำลอง ยังไม่ได้ทดสอบบนบัญชี Hostatom จริง

สำรอง MySQL/MariaDB, `.data` และ encryption key ให้สัมพันธ์กันก่อนอัปเดต อัปโหลดไฟล์เวอร์ชันใหม่โดยไม่ทับ `.env`/`.data` แล้วรัน installer และ Restart App ไม่ควรอัปเดตขณะมีคำขอส่งข้อความกำลังทำงาน การเปลี่ยน DATABASE_URL ไม่ได้ย้ายข้อมูลเดิมให้อัตโนมัติ

อ้างอิง: [คู่มือ Node.js ของ Hostatom](https://kb.hostatom.com/content/6146/), [Plesk Node.js](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/nodejs-support.76652/), [Plesk สร้างฐานข้อมูล](https://support.plesk.com/hc/en-us/articles/12377341716759-How-to-create-a-database-in-Plesk), [Passenger reverse port binding](https://www.phusionpassenger.com/docs/advanced_guides/in_depth/node/reverse_port_binding.html)
