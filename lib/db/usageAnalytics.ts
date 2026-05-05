import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ensureUsageAnalyticsTables } from "@/lib/db/ensureUsageAnalyticsTables";

export type UsageEventType =
  | "draft_created"
  | "game_published"
  | "game_updated"
  | "game_played"
  | "chat_user"
  | "chat_assistant";

function safeJson(detail: unknown) {
  if (detail == null) return null;
  try {
    return JSON.stringify(detail).slice(0, 8000);
  } catch {
    return String(detail).slice(0, 8000);
  }
}

export async function recordUsageEvent(input: {
  eventType: UsageEventType;
  creatorId?: string | null;
  visitorId?: string | null;
  gameId?: string | null;
  detail?: unknown;
}) {
  const eventType = String(input.eventType || "").trim();
  if (!eventType) return;
  await ensureUsageAnalyticsTables();
  await db.execute(sql`
    insert into creator_usage_events (creator_id, visitor_id, game_id, event_type, detail)
    values (
      ${String(input.creatorId || "").trim() || null},
      ${String(input.visitorId || "").trim() || null},
      ${String(input.gameId || "").trim() || null},
      ${eventType},
      ${safeJson(input.detail)}
    )
  `);
}
