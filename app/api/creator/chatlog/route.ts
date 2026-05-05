import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { ensureCreatorUserMessagesTable } from "@/lib/db/ensureCreatorUserMessagesTable";
import { ensureUsageAnalyticsTables } from "@/lib/db/ensureUsageAnalyticsTables";
import { recordUsageEvent } from "@/lib/db/usageAnalytics";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { isSuperAdminId } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function getMyCreatorId(sessArg?: Awaited<ReturnType<typeof getSession>> | null) {
  const sess = sessArg ?? (await getSession());
  const openid = sess?.openid;
  const phone = sess?.phone;
  if (!openid && !phone) return null;
  try {
    await ensureCreatorsAuthFields();
    if (phone) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, phone)).limit(1);
      return row?.id || null;
    }
    if (openid) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, openid)).limit(1);
      return row?.id || null;
    }
  } catch {}
  return null;
}

function normalizeGameId(id: string) {
  return (id || "").trim();
}

function uniqNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((v) => String(v || "").trim()).filter(Boolean)));
}

function rowsOf<T = any>(res: unknown): T[] {
  return Array.isArray((res as any)?.rows) ? ((res as any).rows as T[]) : [];
}

function timeOf(value: unknown) {
  const n = new Date(String(value || "")).getTime();
  return Number.isFinite(n) ? n : 0;
}

type ChatScope = {
  gameIds: string[];
  linkedDraftId: string;
  creatorIds: string[];
  allCreators: boolean;
};

async function getChatScope(
  gameId: string,
  sess: Awaited<ReturnType<typeof getSession>>,
  viewerCreatorId: string | null,
): Promise<ChatScope | null> {
  if (!gameId) return null;
  const isAdmin = isSuperAdminId(viewerCreatorId);
  const ownerKey = ownerKeyFromSession(sess);
  let publishedRows: Array<{ id: string; source_draft_id: string | null; creator_id: string | null }> = [];
  try {
    await ensureGamesCoverFields();
    publishedRows = rowsOf(
      await db.execute(sql`
        select id, source_draft_id, creator_id
        from games
        where id = ${gameId} or source_draft_id = ${gameId}
        limit 20
      `),
    );
  } catch {
    publishedRows = [];
  }

  const gameIds = uniqNonEmpty([
    gameId,
    ...publishedRows.map((r) => r.id),
    ...publishedRows.map((r) => r.source_draft_id),
  ]);
  const publishedCreatorIds = uniqNonEmpty(publishedRows.map((r) => r.creator_id));
  const linkedDraftId = gameIds.find((id) => id !== gameId) || "";

  let ownsDraft = false;
  if (ownerKey) {
    try {
      await ensureCreatorDraftTables();
      for (const id of gameIds) {
        const rows = rowsOf(
          await db.execute(sql`
            select id
            from creator_draft_games
            where id = ${id} and owner_key = ${ownerKey}
            limit 1
          `),
        );
        if (rows.length) {
          ownsDraft = true;
          break;
        }
      }
    } catch {
      ownsDraft = false;
    }
  }

  const isPublishedAuthor = !!viewerCreatorId && publishedCreatorIds.includes(viewerCreatorId);
  const canReadRelatedCreator = isAdmin || ownsDraft || isPublishedAuthor;
  const creatorIds = canReadRelatedCreator
    ? uniqNonEmpty([viewerCreatorId, ...publishedCreatorIds])
    : uniqNonEmpty([viewerCreatorId]);

  // 不是管理员/作者/草稿拥有者时，最多只能读取自己 creatorId 下的同 gameId 消息。
  // 这样既保留旧体验，也避免通过猜 gameId 读取别人的创作记录。
  if (!isAdmin && !creatorIds.length) return null;

  return {
    gameIds,
    linkedDraftId,
    creatorIds,
    allCreators: isAdmin,
  };
}

async function fetchChatRows(scope: ChatScope) {
  const out: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: unknown; sortAt: number }> = [];
  for (const gid of scope.gameIds) {
    try {
      if (scope.allCreators) {
        const rows = rowsOf(
          await db.execute(sql`
            select id, role, content, created_at
            from creator_chat_messages
            where game_id = ${gid}
            order by created_at asc, id asc
            limit 400
          `),
        );
        for (const r of rows) {
          const role = String((r as any).role || "user") === "assistant" ? "assistant" : "user";
          out.push({
            id: `chat:${(r as any).id}`,
            role,
            content: String((r as any).content || ""),
            createdAt: (r as any).created_at,
            sortAt: timeOf((r as any).created_at),
          });
        }
        continue;
      }
      for (const cid of scope.creatorIds) {
        const rows = rowsOf(
          await db.execute(sql`
            select id, role, content, created_at
            from creator_chat_messages
            where creator_id = ${cid} and game_id = ${gid}
            order by created_at asc, id asc
            limit 400
          `),
        );
        for (const r of rows) {
          const role = String((r as any).role || "user") === "assistant" ? "assistant" : "user";
          out.push({
            id: `chat:${(r as any).id}`,
            role,
            content: String((r as any).content || ""),
            createdAt: (r as any).created_at,
            sortAt: timeOf((r as any).created_at),
          });
        }
      }
    } catch {
      // 新表只是增强记录，读取失败时继续尝试旧表。
    }
  }
  return out;
}

async function fetchLegacyUserRows(scope: ChatScope) {
  const out: Array<{ id: string; role: "user"; content: string; createdAt: unknown; sortAt: number }> = [];
  for (const gid of scope.gameIds) {
    try {
      if (scope.allCreators) {
        const rows = rowsOf(
          await db.execute(sql`
            select id, content, created_at
            from creator_user_messages
            where game_id = ${gid}
            order by created_at asc, id asc
            limit 400
          `),
        );
        for (const r of rows) {
          out.push({
            id: `legacy:${(r as any).id}`,
            role: "user",
            content: String((r as any).content || ""),
            createdAt: (r as any).created_at,
            sortAt: timeOf((r as any).created_at),
          });
        }
        continue;
      }
      for (const cid of scope.creatorIds) {
        const rows = rowsOf(
          await db.execute(sql`
            select id, content, created_at
            from creator_user_messages
            where creator_id = ${cid} and game_id = ${gid}
            order by created_at asc, id asc
            limit 400
          `),
        );
        for (const r of rows) {
          out.push({
            id: `legacy:${(r as any).id}`,
            role: "user",
            content: String((r as any).content || ""),
            createdAt: (r as any).created_at,
            sortAt: timeOf((r as any).created_at),
          });
        }
      }
    } catch {
      // 旧表读取失败不应拖垮 create 页。
    }
  }
  return out;
}

function mergeChatRows(
  rows: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: unknown; sortAt: number }>,
) {
  const sorted = rows
    .map((r, index) => ({ ...r, index, textKey: r.content.replace(/\s+/g, " ").trim() }))
    .filter((r) => r.textKey)
    .sort((a, b) => a.sortAt - b.sortAt || a.index - b.index);

  const merged: typeof sorted = [];
  for (const row of sorted) {
    const duplicated = merged.some(
      (prev) => prev.role === row.role && prev.textKey === row.textKey && Math.abs(prev.sortAt - row.sortAt) <= 5000,
    );
    if (!duplicated) merged.push(row);
  }
  return merged.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.createdAt }));
}

async function readPromptFallback(gameIds: string[]) {
  for (const gid of gameIds) {
    try {
      const rows = rowsOf(
        await db.execute(sql`
          select content
          from creator_draft_files
          where game_id = ${gid} and path = 'prompt.md'
          limit 1
        `),
      );
      const content = String((rows[0] as any)?.content || "").trim();
      if (content) return content;
    } catch {}
    try {
      const rows = rowsOf(
        await db.execute(sql`
          select content
          from game_files
          where game_id = ${gid} and path = 'prompt.md'
          limit 1
        `),
      );
      const content = String((rows[0] as any)?.content || "").trim();
      if (content) return content;
    } catch {}
  }
  return "";
}

function firstPromptFromPromptMd(content: string) {
  const first = content
    .split(/\n+/)
    .map((line) => line.replace(/^\s*\d+[.)、]\s*/, "").trim())
    .find(Boolean);
  const text = first || "";
  if (isSeedPromptPlaceholder(text)) return "";
  return text;
}

function isSeedPromptPlaceholder(text: string) {
  const compact = String(text || "").replace(/\s+/g, "").trim();
  return compact === "我想做一个什么小游戏呢？" || compact === "我想做一个什么小游戏呢";
}

export async function GET(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const creatorId = await getMyCreatorId(sess);
  // 有些环境可能还没有创建 creators 记录：聊天记录只是“可选增强”，不要因为它影响创作体验
  if (!creatorId) return json(200, { ok: true, gameId: "", messages: [] });

  const url = new URL(req.url);
  const gameId = normalizeGameId(url.searchParams.get("gameId") || "");
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });

  await ensureCreatorUserMessagesTable();
  try {
    await ensureUsageAnalyticsTables();
  } catch {
    // 新版完整聊天表只是管理看板增强；失败时仍保留旧用户消息读取能力。
  }
  const scope = await getChatScope(gameId, sess, creatorId);
  if (!scope) return json(200, { ok: true, gameId, messages: [], fullMessages: [] });

  const list = mergeChatRows([...(await fetchChatRows(scope)), ...(await fetchLegacyUserRows(scope))]);
  if (!list.length) {
    const fallbackPrompt = firstPromptFromPromptMd(await readPromptFallback(scope.gameIds));
    if (fallbackPrompt) {
      const fallbackMessage = {
        id: "prompt:fallback",
        role: "user" as const,
        content: fallbackPrompt,
        createdAt: null,
      };
      return json(200, {
        ok: true,
        gameId,
        linkedDraftId: scope.linkedDraftId || null,
        messages: [{ id: fallbackMessage.id, content: fallbackMessage.content, createdAt: fallbackMessage.createdAt }],
        fullMessages: [fallbackMessage],
      });
    }
  }
  return json(200, {
    ok: true,
    gameId,
    linkedDraftId: scope.linkedDraftId || null,
    messages: list
      .filter((r) => r.role === "user")
      .map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt })),
    fullMessages: list,
  });
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const creatorId = await getMyCreatorId(sess);
  // 同上：没有 creatorId 时直接忽略写入（不报错）
  if (!creatorId) return json(200, { ok: true, skipped: true });

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }
  const gameId = normalizeGameId(body?.gameId || "");
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const roleRaw = String(body?.role || "user").trim().toLowerCase();
  const role = roleRaw === "assistant" ? "assistant" : "user";
  const runId = String(body?.runId || "").trim().slice(0, 120);
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });
  if (!content) return json(400, { ok: false, error: "MISSING_CONTENT" });

  await ensureCreatorUserMessagesTable();
  await ensureUsageAnalyticsTables();

  if (role === "user") {
    await db.execute(sql`
      insert into creator_user_messages (game_id, creator_id, content)
      values (${gameId}, ${creatorId}, ${content})
    `);
  }
  await db.execute(sql`
    insert into creator_chat_messages (game_id, creator_id, role, content, run_id)
    values (${gameId}, ${creatorId}, ${role}, ${content}, ${runId || null})
  `);
  try {
    await recordUsageEvent({
      eventType: role === "assistant" ? "chat_assistant" : "chat_user",
      creatorId,
      gameId,
      detail: { runId: runId || undefined, chars: content.length },
    });
  } catch {
    // 统计失败不影响聊天主流程
  }
  return json(200, { ok: true });
}
