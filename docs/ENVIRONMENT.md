# ตั้งค่า .env ทีละตัว

คู่มือนี้ใช้กับ **Hostatom/Plesk + MySQL/MariaDB โดยไม่มี Scheduled Tasks** ขั้นตอนติดตั้งอยู่ใน [PLESK-INSTALL.md](PLESK-INSTALL.md) ตัวอย่างโดเมนและรหัสในเอกสารเป็นตัวอย่าง ต้องเปลี่ยนเป็นค่าของคุณ

## เริ่มตรงไหน

### ตั้งผ่านหน้าจอ `/install` (แนะนำ)

1. อัปโหลดโปรเจกต์ ตั้ง Application Root เป็น `cusa`, Document Root เป็น `cusa/public` และ Startup File เป็น `app.cjs`
2. ใน Plesk → Node.js → Run Script เลือก **`install:web`** เพื่อลง dependencies และ build หน้าติดตั้ง โดยยังไม่ต้องกรอกค่าฐานข้อมูล
3. Restart App แล้วเปิด **`https://โดเมนของคุณ/install`**
4. เปิด File Manager → `cusa/.setup/access.key` คัดลอกรหัสมาใส่ในหน้าเว็บ รหัสนี้ใช้เฉพาะการติดตั้งครั้งแรก ไม่ใช่รหัส CUSA SSO และห้ามใส่ใน URL
5. กรอกโดเมน HTTPS, SSO Origin, Application UUID และ Backend API key ของ CUSA
6. กรอก host, port, ชื่อฐานข้อมูล, user และ password ที่สร้างจาก Plesk แล้วกด **ทดสอบฐานข้อมูล** ช่อง password ใส่ค่าจริงได้ ระบบ URL-encode ให้เอง ต้องใช้ฐานข้อมูลเปล่า
7. เติม LINE/Gemini หรือข้ามไปเติมภายหลัง ตรวจรายการแล้วกด **ติดตั้งระบบ**
8. เมื่อติดตั้งสำเร็จให้ **Restart App ใน Plesk** แล้วเข้า `/admin/overview`

ระบบสร้าง `.env` สิทธิ์ `600`, ตารางฐานข้อมูลและการตั้งค่าเริ่มต้นให้ พร้อมปิดการติดตั้งซ้ำ คีย์เข้ารหัสเดิมใน `.env` หรือ `.data/encryption.key` จะถูกเก็บไว้ ถ้ามี `.env` เดิมจะสำรองที่ `.setup/previous.env` ก่อนแทนที่ ไฟล์ `.setup` ทั้งหมดต้องอยู่นอก `public` และไม่อัปโหลดขึ้น repository

**การทดสอบฐานข้อมูลเป็นการอ่านข้อมูลเท่านั้น** ขั้นตอนติดตั้งจึงตรวจสิทธิ์สร้างตารางจริง ส่วน LINE/Gemini/SSO ต้องทดสอบกับบริการหลังติดตั้ง ไม่แสดงค่าลับจากเซิร์ฟเวอร์กลับในหน้าจอ

กรณีติดตั้งค้าง ระบบยอมให้ลองต่อด้วยค่าชุดเดิมและฐานข้อมูลเดิมที่เริ่มสร้างโดย installer นี้ หาก process หยุดระหว่างติดตั้งและพบ `.setup/apply.lock` ให้หยุดแอปใน Plesk ตรวจว่าไม่มี installer ทำงานอยู่ แล้วลบเฉพาะไฟล์ lock ก่อน Restart App **อย่าลบ `.setup/completed` เพื่อเปิดระบบที่ใช้งานแล้วมาติดตั้งใหม่** การย้ายข้อมูลจากฐานเดิมยังต้องทำแยกต่างหาก

### ตั้งด้วยไฟล์เอง

1. อัปโหลดโปรเจกต์และตั้ง Document Root เป็น `cusa/public`
2. ใน Plesk → Node.js → Run Script เลือก `install:plesk` ครั้งแรก ตัวติดตั้งจะสร้าง `.env` ใน Application Root เช่น `cusa/.env`
3. เปิด Plesk → Files/File Manager → `cusa` → `.env` → Edit ถ้าไม่เห็นไฟล์ ให้เปิดการแสดงไฟล์ซ่อน
4. เติม `APP_ORIGIN`, `DATABASE_URL`, `CUSA_SSO_ORIGIN`, `CUSA_CLIENT_ID`, `CUSA_API_KEY` ก่อน เก็บ encryption key ที่ตัวติดตั้งสร้างไว้
5. รัน `install:plesk` อีกครั้งเพื่อสร้างตารางและ build จากนั้น Restart App
6. เติม LINE/Gemini/CUSA ตามฟังก์ชันที่ต้องใช้ แล้ว Restart App ทุกครั้งที่แก้ `.env`

**ห้ามเอา `.env.example` มาทับ `.env` ของระบบจริง** เพราะตัวอย่างเริ่มด้วย `APP_MODE=demo` และไม่มี key เดิม หากมี `.env` อยู่แล้ว installer จะไม่แก้ไขให้ รวมถึงไม่เปลี่ยนค่าฐานข้อมูลหรือโหมด worker เดิม

รูปแบบหนึ่งตัวแปรต่อหนึ่งบรรทัด ไม่ต้องเขียน `export` ไม่ต้องมี `;`:

```dotenv
APP_ORIGIN=https://bot.example.com
CUSA_SSO_ORIGIN=https://sso.reunion.scicu-alumni.com
CUSA_CLIENT_ID=APPLICATION_UUID_FROM_CUSA
CUSA_API_KEY=BACKEND_API_KEY_FROM_CUSA
```

ถ้าค่ามี `#` หรือช่องว่างให้ครอบด้วย quote เช่น `"..."` รหัสผ่านใน `DATABASE_URL` ยังต้อง URL-encode แม้ครอบ quote แล้ว อย่าใช้เว็บสาธารณะเพื่อแปลงรหัสผ่านจริง

Plesk **Custom Environment Variables** ใช้แทนไฟล์ได้ แต่ถ้าตั้งชื่อตัวแปรเดียวกันทั้งสองที่ ค่าจาก environment ของ Plesk จะมาก่อน `.env` จึงควรเลือกเก็บที่เดียว ไฟล์นี้อยู่นอก `public` และไม่ควรส่งเข้ากิตหรือแนบในแชต

## 1. ค่าพื้นฐานของแอป

| ตัวแปร | ค่าบนโฮสต์นี้ | มาจากไหน / หน้าที่ |
| --- | --- | --- |
| `APP_MODE` | `live` | เลือกเอง: `live` ส่ง API จริง, `demo` ใช้ข้อมูลทดลองและไม่ส่ง LINE จริง |
| `NODE_ENV` | `production` | เลือก Production ใน Plesk และใช้ค่านี้ใน `.env`; ใช้คู่กับ `APP_MODE=live` |
| `HOST` | `127.0.0.1` | ที่อยู่ภายในเครื่องที่ Node รับงาน ปล่อยตาม installer; ไม่ใช่โดเมนเว็บและไม่ใช่ DB host |
| `PORT` | `3001` | พอร์ตภายในของแอป ปล่อยตาม installer/ค่าที่ Plesk จัดให้ Passenger รับเว็บผ่าน HTTPS ให้อีกชั้น |
| `APP_ORIGIN` | `https://bot.example.com` | โดเมนหรือ subdomain ที่คุณเพิ่มใน Plesk และเปิด SSL แล้ว ไม่มี `/` ท้าย ไม่มี path หรือ query |
| `DATA_DIR` | `.data` | โฟลเดอร์เก็บไฟล์แนบ/เอกสารเข้ารหัส เทียบจาก Application Root ต้องเขียนได้และเก็บถาวรนอก Document Root |
| `WORKER_MODE` | `opportunistic` | เลือกโหมดสำหรับ shared hosting ไม่มี cron อ่านข้อจำกัดด้านล่าง |

`APP_ORIGIN` ของคุณอาจเป็น `https://bot.reunion.scicu-alumni.com` ถ้านี่คือโดเมนที่สร้างให้แอปจริง อย่าใส่ URL ของ CUSA SSO หรือ URL ของ Plesk control panel ลงช่องนี้

`WORKER_MODE=opportunistic` หมายถึงทำคิวเมื่อแอปเริ่มและเมื่อมี HTTP เข้ามา พร้อมตรวจคิวต่อขณะ process ยังอยู่ หากโฮสต์หยุดแอป งานตั้งเวลา/แจ้งเกิน 5 นาที/retry/retention จะรอจน request ถัดไป **ค่านี้ไม่ได้ทำให้แอปทำงานตลอด 24 ชั่วโมง** ส่วน `continuous` ใช้เมื่อมีพื้นที่รัน process ต่อเนื่องจริง เช่น VPS; เปลี่ยนค่านี้อย่างเดียวไม่ป้องกัน Plesk พักแอป

## 2. DATABASE_URL — ฐานข้อมูลจาก Plesk

**จำเป็น** ต้องมี MySQL 8.0.17+ หรือ MariaDB 10.6+ ไม่ต้องติดตั้ง PostgreSQL/pgvector

1. เข้า Plesk → **Databases → Add Database**
2. สร้างฐานข้อมูลเปล่า เช่น `cusa` เลือกเว็บที่ใช้ และสร้าง database user เช่น `cusa_app`
3. ตั้งรหัสผ่านของผู้ใช้ฐานข้อมูล เก็บไว้ ผู้ใช้ตัวนี้แยกจากบัญชีเข้า Plesk และบัญชี admin ของ Member Desk
4. จด **Database name, Database user, Database server/host, port** ตามที่ Plesk แสดง หากมี prefix ให้คัดลอกชื่อเต็ม เช่น `account_cusa`
5. ให้ผู้ใช้เข้าถึงฐานข้อมูลนี้พร้อมสิทธิ์อ่าน/เขียน, CREATE, ALTER และ INDEX ตัวติดตั้งไม่ต้องใช้ root หรือสร้าง trigger
6. เปิด phpMyAdmin → SQL → `SELECT VERSION();` เพื่อตรวจรุ่น ถ้าไม่มี host/port แสดง ให้ขอค่าการเชื่อมต่อ Node.js จาก Hostatom

อ้างอิงขั้นตอนสร้างฐานข้อมูล: [Plesk](https://support.plesk.com/hc/en-us/articles/12377341716759-How-to-create-a-database-in-Plesk)

ประกอบ URL ตามรูปแบบ:

```dotenv
DATABASE_URL="mysql://DB_USER:URL_ENCODED_PASSWORD@DB_HOST:3306/DB_NAME"
```

ตัวอย่างสมมติ:

| ค่าจาก Plesk | ตัวอย่าง |
| --- | --- |
| User | `account_cusa_app` |
| Password | `Example@123#` |
| Host | `127.0.0.1` |
| Port | `3306` |
| Database | `account_cusa` |

```dotenv
DATABASE_URL="mysql://account_cusa_app:Example%40123%23@127.0.0.1:3306/account_cusa"
```

ตัวอย่างการ encode: `@` → `%40`, `#` → `%23`, `:` → `%3A`, `/` → `%2F`, `?` → `%3F`, `%` → `%25`, ช่องว่าง → `%20` ตัวอักษรทั่วไป/ตัวเลข/`-`/`_` ใช้ตรง ๆ ได้ อย่า encode URL ทั้งบรรทัด และอย่า encode `%40` ที่แปลงแล้วซ้ำ

ถ้าต้องสร้างรหัส URL-safe ใหม่ สามารถรันบนเครื่องของคุณหรือ SSH แล้วนำผลไปตั้งเป็นรหัสของ DB user ใน Plesk:

```sh
openssl rand -hex 24
```

คำสั่งนี้สร้างรหัสให้เลือกใช้ **ไม่ได้เปลี่ยนรหัสใน Plesk ให้** หากรหัส URL-safe นี้ไม่ตรงกับรหัส DB user จะเชื่อมต่อไม่ได้ `mariadb://...` ใช้ได้เช่นกัน; `mysql://...` ใช้เชื่อม MariaDB ได้

### MYSQL_SSL_CA — เฉพาะฐานข้อมูลที่ใช้ TLS

ถ้าใช้ DB ภายในเครื่องตามที่โฮสต์กำหนดและไม่บังคับ TLS ให้เว้นว่าง หากใช้ DB ภายนอกที่รองรับ TLS:

```dotenv
DATABASE_URL="mysql://USER:PASSWORD@db.example.com:3306/cusa?ssl=true"
MYSQL_SSL_CA=/absolute/path/outside/public/mysql-ca.pem
```

ไฟล์ `mysql-ca.pem` ดาวน์โหลดจากผู้ให้บริการฐานข้อมูลเมื่อเขาระบุให้ใช้ CA เฉพาะ แล้วอัปโหลดนอก `public` ใช้ path จริงบน subscription ถ้า certificate เชื่อถือได้อยู่แล้วให้เว้น `MYSQL_SSL_CA` แต่คง `?ssl=true` ไว้ ระบบตรวจ certificate ไม่รองรับการปิดตรวจ TLS ผ่านตัวแปรนี้

หากยังใช้ PostgreSQL บนเครื่องอื่น โค้ดยังรองรับ `postgresql://...` และ pgvector แต่ไม่จำเป็นสำหรับการติดตั้ง MySQL/MariaDB นี้ การสลับ URL **ไม่ได้ย้ายข้อมูลจากฐานเดิม** ให้ใช้ฐานเปล่าสำหรับการติดตั้งใหม่

## 3. Key เข้ารหัสข้อมูล

| ตัวแปร | จำเป็น | เอามาจากไหน |
| --- | --- | --- |
| `DATA_ENCRYPTION_KEY` | ใช่ | installer สร้างสุ่ม 32 bytes แล้ว encode เป็น base64 ให้ใน `.env` |

กรณีติดตั้งใหม่ด้วยมือ สร้าง encryption key ได้ด้วย:

```sh
openssl rand -base64 32
```

คัดลอกผลหนึ่งบรรทัดใส่ `DATA_ENCRYPTION_KEY` **ทำเฉพาะระบบใหม่ที่ยังไม่มีข้อมูล** เมื่อมีแชตแล้วต้องใช้ key เดิม การเปลี่ยน/สูญหายทำให้อ่านข้อความและไฟล์เดิมไม่ได้ สำรอง key คู่กับฐานข้อมูลและ `.data`

ไม่ต้องมี `ADMIN_EMAIL` หรือ `ADMIN_PASSWORD` เจ้าหน้าที่ใช้ CUSA SSO และ Member Desk ตรวจบทบาทของ application นี้ก่อนสร้างบัญชีเมื่อเข้าใช้ครั้งแรก รหัส CUSA ไม่ถูกส่งเข้าหรือเก็บใน Member Desk

## 4. LINE Messaging API — รับและตอบข้อความ

`LINE_CHANNEL_SECRET` และ `LINE_CHANNEL_ACCESS_TOKEN` จำเป็นเมื่อเปิดรับ/ส่ง LINE จริง

### เตรียม OA และ Channel

1. เปิด [LINE Official Account Manager](https://manager.line.biz/) เลือก OA ขององค์กร หรือสร้าง OA
2. ที่ Settings → Messaging API เปิดใช้งาน Messaging API แล้วเลือก **Provider ขององค์กร**
3. เข้า [LINE Developers Console](https://developers.line.biz/console/) ด้วยบัญชีผู้ดูแล เลือก Provider นั้นและ **Messaging API channel** ของ OA
4. ใช้ Provider เดียวกับ LINE Login/LIFF ในหัวข้อถัดไป เพราะ User ID ของบุคคลเดียวกันต่างกันเมื่ออยู่คนละ Provider

ช่อง Messaging API สร้างผ่านการเปิดใช้ใน OA Manager ไม่ใช่สร้างใหม่จาก Developers Console โดยตรง ดู [คู่มือ LINE](https://developers.line.biz/en/docs/messaging-api/getting-started/)

### LINE_CHANNEL_SECRET

- ใน Messaging API channel เปิดแท็บ **Basic settings → Channel secret** แล้วคัดลอกค่า
- ใส่ `LINE_CHANNEL_SECRET=...`
- ใช้ตรวจลายเซ็น webhook ต้องเป็น secret ของ Messaging API channel นี้ ไม่ใช่ secret ของ LINE Login

### LINE_CHANNEL_ACCESS_TOKEN

- ใน channel เดิมเปิดแท็บ **Messaging API → Channel access token (long-lived)** แล้ว Issue ตามสิทธิ์ที่มี
- ใส่ `LINE_CHANNEL_ACCESS_TOKEN=...`
- ใช้ส่ง Reply/Push, โหลดภาพ, อ่าน Rich Menu และแสดง Loading หากหมุน token ต้องแก้ `.env` และ Restart App

จากนั้นตั้งในหน้า Messaging API:

```text
Webhook URL: https://bot.example.com/api/webhook
Use webhook: Enabled
Webhook redelivery: Enabled
```

เปลี่ยนโดเมนให้ตรง `APP_ORIGIN` กด Verify หลังแอปเริ่มและตั้ง secret แล้ว จากนั้นเพิ่ม OA เป็นเพื่อนและส่งข้อความจริงเพื่อทดสอบ การ Verify อย่างเดียวไม่ยืนยันว่าบอทตอบหรือส่ง Push สำเร็จ

ตั้งข้อความตอบอัตโนมัติ/ทักทายใน OA Manager ไม่ให้ตอบซ้อนกับระบบ เจ้าหน้าที่ต้องตอบผ่าน **Member Desk** เพื่อเก็บบทสนทนาฝั่งเจ้าหน้าที่ครบ ข้อความที่เจ้าหน้าที่ส่งจาก OA Manager โดยตรงไม่ได้ถูกนำเข้ามาครบโดยระบบนี้

ดู [การตั้งบอทและ webhook](https://developers.line.biz/en/docs/messaging-api/building-bot/)

## 5. LINE Login และ LIFF — ผูกสมาชิกกับ CUSA

ส่วนนี้จำเป็นเมื่อใช้หน้าผูกสมาชิกกับ CUSA หากยังเปิดเฉพาะรับแชตสามารถเว้นไว้ก่อน

| ตัวแปร | เอามาจากไหน |
| --- | --- |
| `LINE_LOGIN_CHANNEL_ID` | Channel ID ใน Basic settings ของ **LINE Login channel** เป็นตัวเลข ไม่ใช่ Messaging API Channel ID |
| `LIFF_ID` | ID หลังเพิ่มแอปในแท็บ LIFF เช่น `1234567890-AbcdEfgh` ใส่เฉพาะ ID ไม่ใส่ URL ทั้งเส้น |

1. ใน LINE Developers Console เลือก Provider **เดียวกับ OA** แล้วสร้างหรือเลือก LINE Login channel ของเว็บ
2. คัดลอก Channel ID ใส่ `LINE_LOGIN_CHANNEL_ID`
3. ใน channel นั้นไป **LIFF → Add** กำหนดชื่อแอป, Size = Full และ Endpoint URL = `https://bot.example.com/connect`
4. เลือก scope `openid` เพื่อให้แอปได้ ID token และ `profile` สำหรับข้อมูลพื้นฐาน ไม่ต้องเพิ่ม `chat_message.write` สำหรับขั้นตอนนี้
5. เพิ่มแอปแล้วคัดลอก LIFF ID ใส่ `LIFF_ID` และใช้ **LIFF URL** `https://liff.line.me/LIFF_ID` เป็นลิงก์ที่ให้สมาชิกกดจาก Rich Menu
6. เชื่อม OA กับ LINE Login channel ตามตัวเลือกของ Console และ Publish channel เมื่อพร้อมให้ผู้ใช้ทั่วไปใช้งาน โหมด Developing จำกัดผู้ทดสอบตามบทบาท ดู [สถานะ channel ใน LINE Developers Console](https://developers.line.biz/en/docs/line-developers-console/overview/)

LIFF endpoint คือ `/connect` ส่วน `/api/auth/callback` เป็น callback ของ **CUSA** อย่านำสองค่านี้สลับกัน `LINE_LOGIN_CHANNEL_SECRET` ไม่ได้ใช้ในโค้ดชุดนี้ จึงไม่ต้องเพิ่มเอง

อ้างอิง [เพิ่ม LIFF app](https://developers.line.biz/en/docs/liff/registering-liff-apps/) และ [ขอบเขต User ID ตาม Provider](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)

## 6. LINE ผู้รับแจ้งเตือนและ Loading

| ตัวแปร | ค่า / ที่มา | เว้นว่างได้ไหม |
| --- | --- | --- |
| `LINE_AGENT_ALERT_USER_ID` | Messaging API User ID ของผู้รับแจ้งเคสใหม่ส่วนกลาง | ได้ ถ้าไม่ใช้แจ้งส่วนกลาง |
| `LINE_SUPERVISOR_ALERT_USER_ID` | User ID ของหัวหน้าที่รับแจ้งรอเจ้าหน้าที่เกิน 5 นาที | ได้ ถ้าไม่ใช้แจ้งหัวหน้า |
| `LINE_LOADING_ENABLED` | คุณกำหนด `true` เพื่อแสดงกำลังตอบ หรือ `false` เพื่อปิด | ค่าเริ่มต้น `true` |
| `LINE_LOADING_SECONDS` | คุณกำหนด `5`–`60` เพิ่มทีละ 5 เช่น `30` | ค่าเริ่มต้น `30` |

User ID ต้องเป็น **`U` ตามด้วยเลขฐานสิบหก 32 ตัว** เป็นค่าจาก LINE ไม่ใช่ชื่อแสดงผล, เบอร์โทร, `@ชื่อOA` หรือ LINE ID สำหรับค้นหาเพื่อน ผู้รับต้องเพิ่ม OA เป็นเพื่อน

หา User ID ได้สองวิธี:

1. **บัญชีผู้พัฒนาเอง:** ใน Basic settings ของ Messaging API channel ดู Your user ID หากบัญชีมีสิทธิ์และแสดงข้อมูลนี้
2. **เจ้าหน้าที่คนอื่น:** ให้เพิ่ม OA และพิมพ์ข้อความรหัสที่ตกลงกัน เช่น `SETUP-NALIN-1234` เมื่อระบบรับ webhook แล้ว ผู้ดูแลเปิด phpMyAdmin ของแอปและค้นหาเฉพาะรหัสดังกล่าว:

```sql
SELECT c.number AS case_number, u.line_user_id, m.created_at
FROM users u
JOIN conversations c ON c.user_id=u.id
JOIN messages m ON m.conversation_id=c.id
WHERE m.sender_type='USER' AND m.redacted_text LIKE '%SETUP-NALIN-1234%'
ORDER BY m.created_at DESC
LIMIT 5;
```

ยืนยันเวลาและรหัสกับเจ้าหน้าที่ก่อนนำ ID มาใช้ ขั้นตอนนี้อ่าน `source.userId` ที่ระบบเก็บจาก webhook ตาม [คู่มือ LINE User ID](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/) ไม่จำเป็นต้องเปิด log ข้อความดิบ

**การแจ้งเตือน Ticket รายบุคคลไม่ใส่ใน `.env`:** ไป Member Desk → ตั้งค่าระบบ → LINE และการเชื่อมต่อ → ตั้งค่า LINE ของเจ้าหน้าที่ → ใส่ User ID → เปิดรับแจ้งเตือน ถ้าระบุผู้รับเคสจะแจ้งคนนั้น ถ้าส่งเข้าคิวหน่วยงานจะแจ้งสมาชิกทีมที่เปิดรับไว้

Loading แสดงเฉพาะตอนสมาชิกเปิดแชตส่วนตัวกับ OA และหายเมื่อบอทตอบหรือครบเวลา ไม่ใช่ notification และไม่ได้ใช้กับกลุ่ม หากเรียก Loading API ไม่สำเร็จ ระบบยังพยายามตอบตามปกติ ดู [LINE loading indicator](https://developers.line.biz/en/docs/messaging-api/use-loading-indicator/)

## 7. Rich Menu ของสมาชิกและผู้เยี่ยมชม

| ตัวแปร | ที่มา / หน้าที่ |
| --- | --- |
| `LINE_MEMBER_RICH_MENU_ID` | `richMenuId` ของเมนูสมาชิกที่สร้างผ่าน Messaging API ใช้หลังผูก CUSA สำเร็จ |
| `LINE_GUEST_RICH_MENU_ID` | `richMenuId` ของเมนูผู้เยี่ยมชม ใช้ตอนกลับสู่สถานะผู้เยี่ยมชมตาม workflow |

ทั้งสองตัวเป็น **ตัวเลือก** ถ้ายังไม่มีเมนูให้เว้นว่าง ไม่ต้องใส่ชื่อเมนูหรือ LIFF ID แทน

หลังตั้ง token แล้ว ใน Plesk Run Script เลือก **`config:rich-menus`** หรือรัน:

```sh
npm run config:rich-menus
```

คำสั่งอ่านรายการเมนูของ OA แสดงชื่อกับ ID ไม่ส่งข้อความ เลือก ID ของเมนูที่ต้องการใส่ตัวแปร เมนูจาก OA Manager และเมนูที่สร้างผ่าน API มีข้อจำกัดการใช้งานต่างกัน หากรายการว่างต้องเตรียมเมนูผ่าน Messaging API ก่อน ไม่ได้สร้างเมนูให้อัตโนมัติ ดู [Rich menus](https://developers.line.biz/en/docs/messaging-api/using-rich-menus/)

## 8. Gemini — คีย์และโมเดล

### GEMINI_API_KEY

1. เปิด [Google AI Studio](https://aistudio.google.com/) ด้วยบัญชีองค์กร
2. ไป Dashboard → Projects เลือก/นำเข้า Google Cloud project ที่จะใช้ แล้วไป **API Keys → Create API key**
3. คัดลอก key ใส่ `GEMINI_API_KEY` โดยไม่เพิ่ม prefix `Bearer`
4. หากปุ่มสร้างคีย์ไม่พร้อม ให้ผู้ดูแล Google Cloud ให้สิทธิ์กับ project หรือสร้าง key ให้ ตรวจโควตาและ billing ของ project ตามการใช้งาน

ดู [คู่มือ API key ของ Google](https://ai.google.dev/gemini-api/docs/api-key) ตัวแปรนี้เป็นคีย์ฝั่งเซิร์ฟเวอร์ ไม่ต้องใส่ prefix `VITE_` และไม่วางในโค้ดหน้าเว็บ

### GEMINI_MODEL

เป็น **model ID** ที่รองรับ `generateContent` ใช้ร่างคำตอบและวิเคราะห์บทสนทนา ไม่ใช่ชื่อ project, display name หรือ API key

หลังกรอก key แล้ว เลือก Plesk Run Script → **`config:models`** หรือรัน:

```sh
npm run config:models
```

คำสั่งใช้ key อ่าน [รายชื่อโมเดล](https://ai.google.dev/api/models) และความสามารถของแต่ละตัว ไม่สร้างคำตอบ เลือกค่าคอลัมน์ `id` ที่มี `generateContent` ใส่ `GEMINI_MODEL` โดย **ไม่ใส่ `models/` นำหน้า** ตรวจสิทธิ์/โควตาของ model ที่เลือกด้วย รุ่นที่มีอาจเปลี่ยนตามบัญชีและเวลา จึงไม่ล็อกชื่อรุ่นไว้ในตัวอย่าง

### GEMINI_EMBEDDING_MODEL

ตัวเลือกสำหรับค้นหาความรู้ด้วยความหมาย จากผล `config:models` เลือก ID ที่รองรับ `embedContent` และใน [เอกสาร embeddings](https://ai.google.dev/gemini-api/docs/embeddings) รองรับ `outputDimensionality=768` ตามที่แอปใช้ ไม่ใช้ generation model แทน

เว้นว่างได้ ระบบยังค้นหาจากคำค้นภาษาไทยและความรู้ที่เผยแพร่แล้ว MySQL/MariaDB เก็บ vector เป็น JSON และจัดอันดับในแอป ไม่ต้องมี pgvector หากเปลี่ยน embedding model ความรู้เก่าต้องสร้าง embedding รุ่นใหม่ก่อนจึงจะค้นด้วยรุ่นนั้นได้

### AI_ANALYTICS_ENABLED

- `false`: ยังไม่ส่งบทสนทนาไปวิเคราะห์อัตโนมัติ เป็นค่าเริ่มต้น
- `true`: เปิดวิเคราะห์เคสที่ปิดหรือว่างตามเงื่อนไข ต้องมี `GEMINI_API_KEY` และ `GEMINI_MODEL` ที่ใช้ได้จริง
- ระบบส่งบริบทสาธารณะของบทสนทนาที่จำกัดขนาดและปกปิดข้อมูลเบื้องต้น ไม่รวมบันทึกภายใน รายละเอียดอยู่ใน README ส่วนข้อมูลฝึก

ถ้าเว้น Gemini key/model บอทยังใช้คำตอบทางการจากฐานความรู้ และส่งต่อเมื่อไม่มีคำตอบพอ การฝึกโมเดลอัตโนมัติไม่ใช่หน้าที่ของตัวแปรนี้ ชุดข้อมูลฝึกส่งออกจากหน้า **ชุดข้อมูล AI**

## 9. CUSA SSO — ขอจากผู้ดูแลระบบ CUSA

| ตัวแปร | ค่าและที่มา |
| --- | --- |
| `CUSA_SSO_ORIGIN` | origin ของ SSO เช่น `https://sso.reunion.scicu-alumni.com` ไม่มี `/login`, query หรือ path ต่อท้าย |
| `CUSA_CLIENT_ID` | UUID ของ application/service **Member Desk** ที่ผู้ดูแล CUSA ลงทะเบียนให้ ไม่ใช่เลข channel ของ LINE |
| `CUSA_API_KEY` | API key ฝั่ง backend ของ application นั้น ใช้ header `X-API-Key` ใส่เฉพาะค่าคีย์ |

ส่งข้อมูลนี้ให้ผู้ดูแล CUSA SSO ผ่านช่องทางองค์กร:

```text
ชื่อบริการ: CUSA Member Desk
Origin: https://bot.example.com
Redirect URI เจ้าหน้าที่: https://bot.example.com/api/auth/sso/callback
Redirect URI ผูกสมาชิกกับ LINE: https://bot.example.com/api/auth/callback
Flow: Authorization Code + PKCE S256
Claim scopes ที่แอปขอ: identity:read profile email
API key permissions: identity:read, token:introspect และ token:revoke
Role codes สำหรับเจ้าหน้าที่: admin, agent, reviewer (ตัวเล็กตรงตามนี้)
Role สำหรับสมาชิก LINE: ใช้ role สมาชิกของ CUSA แยกจาก 3 บทบาทเจ้าหน้าที่
ต้องการ: application UUID, backend API key, เปิด service และกำหนด admin ให้ผู้ดูแลรายแรก
```

เปลี่ยนโดเมนก่อนส่ง ขอค่าเฉพาะแอปนี้ตาม [OpenAPI CUSA 1.5.0](cusa-sso.openapi.json) เอกสารที่ให้มาไม่ได้ระบุขั้นตอนหน้า Admin สำหรับออกคีย์ จึงต้องให้ผู้ดูแล CUSA ลงทะเบียน/ออกคีย์ ไม่สามารถสร้าง `CUSA_CLIENT_ID` โดยสุ่ม UUID เองแล้วใช้งานได้

URL `/login?auth=success&status=mfa_required` ที่เห็นในเบราว์เซอร์ไม่ใช่ API key หรือหลักฐานว่าผูกสมาชิกสำเร็จ แอปจะเริ่ม authorize และแลก code ตามสัญญา API เอง

ฟิลด์ชื่อ/อีเมลอาจไม่มีเมื่อผู้ใช้ไม่อนุญาต ระบบยึด `sub` ของ CUSA เป็นตัวตน ไม่รวมบัญชีเดิมจากอีเมลอัตโนมัติ `aud` ต้องตรง Application UUID และต้องมี `identity:read`

CUSA ยืนยันตัวตนและส่งชื่อบทบาท ส่วน **Member Desk กำหนดและบังคับสิทธิ์เองที่ API**:

| Role code ที่ CUSA ส่ง | สิทธิ์ใน Member Desk |
| --- | --- |
| `admin` | งานเจ้าหน้าที่ทั้งหมด จัดการหน่วยงาน การตั้งค่า LINE/AI/นโยบายข้อมูล บรอดแคสต์ และงานตรวจทาน |
| `agent` | อ่านบทสนทนา รับ/ตอบ/โอน/ปิดเคสตามผู้รับผิดชอบ เตรียมร่างฐานความรู้และตัวอย่างฝึก |
| `reviewer` | อ่านบทสนทนา ตรวจ/อนุมัติฐานความรู้และข้อมูลฝึก สร้าง/ส่งออกชุดข้อมูล รับ/ตอบ/โอน/ปิดเคสไม่ได้ |

ชื่อบทบาทแยกตัวเล็กใหญ่ หากมีหลายบทบาทเลือก `admin` ก่อน `reviewer` ก่อน `agent` ผู้ตรวจทานกับเจ้าหน้าที่เป็นคนละหน้าที่ หากต้องทำทั้งสองให้กำหนด `admin` ตามนโยบายองค์กร บทบาท global admin ของ CUSA หรือ `member` ไม่ได้สิทธิ์เข้าหลังบ้านนี้โดยอัตโนมัติ ผู้สร้างข้อมูลอนุมัติตัวอย่างฝึกของตัวเองไม่ได้แม้เป็น admin

ผู้ดูแลรายแรกต้องมี `admin` **ใน application ของ Member Desk** อยู่ก่อน ระบบไม่ยกระดับผู้ที่ล็อกอินคนแรก รายชื่อเจ้าหน้าที่จะปรากฏเมื่อผ่าน SSO ครั้งแรก แล้วจึงจัดเข้าหน่วยงาน/ตั้งแจ้งเตือน LINE ใน Member Desk ได้

**อัปเดตจากบัญชี local เดิม:** เติมค่า CUSA ใน `.env` แล้ว restart แอปจะสร้างตาราง SSO เพิ่มโดยไม่ลบเคสเดิม ช่องทางล็อกอินด้วยอีเมล/รหัสเดิมถูกปิด ถ้าอีเมลชนบัญชีเดิมระบบจะปฏิเสธ ต้องทำการย้ายตัวตนโดยผู้ดูแลหลังยืนยัน `sub` ไม่แก้ให้เชื่อมด้วยอีเมลเองหรือใช้ `/install` ติดตั้งทับฐานข้อมูลเดิม

**อายุการเข้าสู่ระบบ:** รองรับ OpenAPI 1.5.0 โดยขอ `request_refresh_token: true` ตอนแลก authorization code เฉพาะเจ้าหน้าที่ ให้ล็อกอินต่อเนื่องได้ **สูงสุด 8 ชั่วโมงนับจากการเข้าใช้ครั้งนั้น** หรือจน refresh token/MFA session/API key ของ CUSA หมดอายุ หากสั้นกว่า ไม่มีการยืดเป็น 8 ชั่วโมงใหม่ทุกครั้งที่ใช้งาน

ไม่ต้องเพิ่มตัวแปรอายุ session ใน `.env` ใช้ `CUSA_API_KEY` ชุดเดิมที่ออก refresh token คีย์ต้องมี `identity:read` สำหรับแลก/ต่ออายุ, `token:introspect` สำหรับตรวจสิทธิ์ และ `token:revoke` สำหรับออกจากระบบ หากเปลี่ยนคีย์ เจ้าหน้าที่ต้องเข้าสู่ SSO ใหม่

Access token ยังมีอายุไม่เกิน 300 วินาที เมื่อมีคำขอใช้งานและเหลือไม่เกิน 30 วินาที ระบบจะต่ออายุฝั่งเซิร์ฟเวอร์ผ่าน `/api/sso/token` ด้วย `grant_type: refresh_token` เก็บ access/refresh token แบบเข้ารหัส และแทนที่ทั้งคู่ใน transaction เดียว ไม่มี token ของ CUSA ส่งไป browser, cookie หรือ localStorage

ระบบล็อกการหมุน token ผ่านฐานข้อมูลเพื่อรองรับหลายแท็บ/หลาย Node process และบันทึกสถานะก่อนเรียก CUSA ถ้าคำขอ timeout, provider ตอบผิดพลาด, บันทึกผลไม่ได้ หรือเซิร์ฟเวอร์หยุดระหว่างหมุน token จะให้เข้าสู่ระบบใหม่ **ไม่ใช้ refresh token เดิมลองซ้ำ** เพราะอาจทำให้ CUSA ถอน token ทั้งชุด การรอการหมุนที่ค้างไม่ทำให้ token เดิมกลับมาใช้ได้

ทุก protected API ยังตรวจ `/api/sso/introspect` แบบไม่มี identity cache ตรวจ `active/aud/exp/sub/roles/scope` ก่อนให้ทำงาน หาก CUSA ตรวจสิทธิ์ไม่ได้จะไม่อนุญาตให้ดำเนินการ การต่ออายุไม่เพิ่ม scope หรือหลีกเลี่ยงการถอนสิทธิ์

เมื่อออกจากระบบ Member Desk จะลบเซสชันท้องถิ่น ล้าง cookie และขอ CUSA ถอน token ของ service นี้ หาก CUSA ไม่ตอบรับ หน้าจอจะแจ้งว่าถอนฝั่ง CUSA ไม่สำเร็จ แต่เซสชัน Member Desk ถูกปิดแล้ว

**อัปเดตระบบเดิม:** Deploy/build และ Restart App ตามปกติ ระบบเพิ่มตาราง `staff_sso_refresh` โดยไม่แก้หรือลบข้อมูลเคส ไม่ต้องเปิด `/install` ใหม่ เซสชันเก่าจะมีอายุเท่าเดิมจนเข้าสู่ SSO ใหม่แล้วได้รับ refresh token หาก CUSA ตอบเฉพาะ access token ระบบจะใช้เซสชันสั้นตามอายุ access token ไม่อ้างว่าต่ออายุได้

**Shared Hosting:** ต่ออายุเมื่อมีคำขอ จึงไม่ต้องใช้ Scheduled Task ถ้าแอปพักแล้วกลับมาภายในอายุ refresh token จะต่ออายุและตรวจสิทธิ์ก่อนทำงาน หากหมดอายุ/ถูกถอนจะให้ยืนยันตัวตนในแท็บใหม่ ข้อความร่างอยู่ในหน้าเดิมได้ระหว่างยืนยัน ห้ามปิดหรือ reload หน้าเดิมก่อนส่ง

## 10. อายุข้อมูล

| ตัวแปร | ค่าเริ่มต้น | ใครกำหนด / ผล |
| --- | --- | --- |
| `CHAT_RETENTION_DAYS` | `180` | องค์กรกำหนดอายุแชต/ไฟล์ที่ระบบเก็บ เมื่องานครบอายุทำงานจะล้างเนื้อหาตามนโยบายและถอนข้อมูลฝึกที่อ้างอิง |
| `DATASET_RETENTION_DAYS` | `180` | องค์กรกำหนดอายุ dataset snapshots ที่เก็บในระบบ |

ใส่จำนวนเต็ม `1`–`3650` วัน ไม่ใส่หน่วยหรือ `0` ค่าเหล่านี้ไม่ได้เก็บบทสนทนาตลอดไป การลดอายุอาจทำให้ข้อมูลเก่าถูกล้างในรอบถัดไป บนโฮสต์ไม่มี cron รอบล้างข้อมูลอาจช้าเมื่อแอปพัก และไม่สามารถเรียกคืน JSONL ที่ดาวน์โหลดออกไปแล้วได้

## 11. ชุดค่าที่ควรเปิดทีละขั้น

| ขั้น | กรอกตัวแปร | ผลที่ตรวจได้ |
| --- | --- | --- |
| เปิดเว็บ | `APP_MODE`, `NODE_ENV`, `APP_ORIGIN`, `DATABASE_URL`, `DATA_DIR`, key/admin และ `WORKER_MODE` | installer ผ่าน, health 200, เข้า admin ได้ |
| รับแชต | LINE secret/token และ Loading | Verify webhook, ส่งข้อความจาก LINE, เห็นประวัติ/คำตอบ |
| แจ้งเจ้าหน้าที่ | LINE alert IDs และตั้ง LINE รายบุคคลในหน้า Settings | โอนเคสแล้วแจ้งผู้รับที่เลือก |
| เปิด AI | Gemini key/model, embedding/analytics ตามต้องการ | คำตอบจากความรู้และผลวิเคราะห์ที่เปิดใช้ |
| ผูกสมาชิก | LINE Login Channel ID, LIFF ID, CUSA 3 ตัว | เปิด LIFF → ยืนยัน CUSA → กลับเว็บสำเร็จ |
| เมนูและนโยบาย | Rich Menu IDs, retention | เมนูตรงสถานะและอายุข้อมูลตรงนโยบาย |

ค่าจาก Plesk ที่ติดตั้งใหม่อาจมี `APP_MODE=live`, `NODE_ENV=production`, `HOST`, `PORT`, `DATA_DIR`, encryption key อยู่แล้ว ให้ตรวจแล้วเติมส่วนที่ว่าง ไม่ต้องสร้าง key ใหม่

## 12. ตรวจปัญหาที่พบบ่อย

| อาการ | ตรวจอะไร |
| --- | --- |
| installer ไม่ผ่าน Node version | เลือก Node 22.12+ ใน Plesk; Node ที่ Terminal ใช้อาจคนละตัว |
| `/install` แจ้งว่าติดตั้งแล้ว | ระบบมีค่าพร้อมใช้หรือผ่านการติดตั้งแล้ว ใช้ `.env` สำหรับแก้ค่าและ `install:plesk` สำหรับอัปเดต |
| หน้าติดตั้งปฏิเสธฐานข้อมูล | ต้องใช้ DB เปล่า หรือการติดตั้งค้างของ installer นี้ด้วยค่าชุดเดิม |
| ไม่เห็นหน้าติดตั้งหลังอัปโหลด | รัน `install:web` ให้ build ผ่านก่อน เลือก startup `app.cjs` แล้ว Restart App |
| ติดตั้งแล้วแต่ยังเห็นหน้าเดิม | Restart App ใน Plesk เพื่อโหลด `.env` ใหม่ ขั้นตอนเว็บไม่สั่ง restart โฮสต์ให้ |
| DB access denied | ชื่อ user/รหัส, prefix ของ Plesk, host ที่อนุญาต และ percent-encoding |
| ไม่พบฐานข้อมูล | สร้าง DB ใน Plesk ก่อน ใช้ชื่อเต็มใน URL |
| รุ่น MySQL/MariaDB ไม่ผ่าน | ดู `SELECT VERSION();` แล้วขอรุ่นที่รองรับจากโฮสต์ |
| แก้ `.env` แล้วไม่เปลี่ยน | Restart App และตรวจค่าชื่อซ้ำใน Custom Environment Variables |
| webhook ไม่ผ่าน | HTTPS, URL `/api/webhook`, Channel secret ของ OA ที่ถูกต้อง |
| LINE อ่านคีย์ได้แต่ไม่ส่ง | token ยังใช้ได้, OA/Provider ตรง, ผู้รับเพิ่มเพื่อน, โควตาเหลือ และ `APP_MODE=live` |
| LIFF ยืนยัน LINE ไม่ได้ | LINE Login Channel ID ตรงกับ LIFF app, scope `openid`, channel พร้อมใช้ |
| CUSA callback ไม่ผ่าน | callback ตรงทุกตัวอักษร, application UUID/API key ของ service เดียวกัน, scopes/roles ถูกกำหนด |
| Gemini 401/403/404/429 | key/permission, model ID ที่มีในบัญชี, เปิด API และโควตา/billing |
| ส่งตามเวลาช้า | ข้อจำกัด `opportunistic` เมื่อโฮสต์พัก ตรวจเวลาทำงานล่าสุดใน Settings |
| อ่านแชต/ไฟล์เดิมไม่ได้หลังติดตั้งใหม่ | ตรวจว่ากู้ฐานข้อมูลและ `.data` พร้อม encryption key ชุดเดียวกัน |

คำว่า “ตั้งค่าแล้ว” ในหน้าเชื่อมต่อหมายถึงพบค่า ไม่ใช่ผลทดสอบ API จริง ทดสอบด้วยบัญชีองค์กรก่อนเปิดบริการ

ตัวแปร `POSTGRES_PASSWORD` ใน `compose.yaml` ใช้เฉพาะทางเลือก Docker/PostgreSQL ไม่ต้องใส่สำหรับ Plesk/MySQL ส่วน `TEST_MYSQL_URL` ใช้เฉพาะนักพัฒนารันชุดทดสอบ ไม่ใช่ค่าระบบจริง
