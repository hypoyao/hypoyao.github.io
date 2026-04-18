import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 creators 表补齐 phone/openid 字段与索引（幂等）
export async function ensureCreatorsAuthFields() {
  await db.execute(sql`alter table creators add column if not exists phone text;`);
  await db.execute(sql`alter table creators add column if not exists openid text;`);
  await db.execute(sql`create unique index if not exists creators_phone_uidx on creators(phone);`);
  await db.execute(sql`create unique index if not exists creators_openid_uidx on creators(openid);`);
}

