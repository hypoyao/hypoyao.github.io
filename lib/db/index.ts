import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

// 在 Vercel Project 的环境变量中设置 DATABASE_URL（Neon 提供）
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL env var");
}

const sql = neon(databaseUrl);
export const db = drizzle(sql);

