import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const creators = pgTable("creators", {
  id: text("id").primaryKey(), // slug，例如 'haibo'
  name: text("name").notNull(),
  avatarUrl: text("avatar_url").notNull(),
  profilePath: text("profile_path").notNull(),
  // 登录账号（可选）：手机号（历史字段 openid 目前不再使用）
  phone: text("phone"),
  openid: text("openid"),
  // 个人信息（可选）
  gender: text("gender"), // '男' | '女' | '其他' | '保密'
  age: integer("age"),
  city: text("city"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const games = pgTable("games", {
  id: text("id").primaryKey(), // slug，例如 'ttt'
  title: text("title").notNull(),
  shortDesc: text("short_desc").notNull(),
  ruleText: text("rule_text").notNull(),
  coverUrl: text("cover_url").notNull(),
  // 自定义封面（可选）：存储图片数据；coverUrl 仍存相对路径（如 /assets/covers/<id>）
  coverMime: text("cover_mime"),
  coverData: text("cover_data"),
  path: text("path").notNull().unique(),
  creatorId: text("creator_id")
    .notNull()
    .references(() => creators.id, { onUpdate: "cascade", onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inviteCodes = pgTable("invite_codes", {
  code: text("code").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  note: text("note"),
  lastUsedPhone: text("last_used_phone"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
