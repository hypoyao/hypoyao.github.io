import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const creators = pgTable("creators", {
  id: text("id").primaryKey(), // slug，例如 'haibo'
  name: text("name").notNull(),
  avatarUrl: text("avatar_url").notNull(),
  profilePath: text("profile_path").notNull(),
  // 登录账号（可选）：手机号（历史字段 openid 目前不再使用）
  phone: text("phone"),
  openid: text("openid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const games = pgTable("games", {
  id: text("id").primaryKey(), // slug，例如 'ttt'
  title: text("title").notNull(),
  shortDesc: text("short_desc").notNull(),
  ruleText: text("rule_text").notNull(),
  coverUrl: text("cover_url").notNull(),
  path: text("path").notNull().unique(),
  creatorId: text("creator_id")
    .notNull()
    .references(() => creators.id, { onUpdate: "cascade", onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
