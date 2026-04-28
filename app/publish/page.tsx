import { getSession } from "@/lib/auth/session";
import PublishForm from "./PublishForm";
import { db } from "@/lib/db";
import { creators, games as gamesTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { isSuperAdminId } from "@/lib/auth/admin";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function readDraftFile(gameId: string, filePath: string) {
  try {
    await ensureCreatorDraftTables();
    const rows = await db.execute(sql`
      select content
      from creator_draft_files
      where game_id = ${gameId} and path = ${filePath}
      limit 1
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    const content = list?.[0]?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}

function parseTitleFromHtml(html: string) {
  const m = html.match(/<title>\s*([^<]{1,80})\s*<\/title>/i);
  return (m?.[1] || "").trim();
}

export default async function PublishPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sess = await getSession();
  if (!sess) {
    return (
      <main className="wrap">
        <section className="card homeCard createBento">
          <header className="header">
            <h1>发布游戏</h1>
            <p className="desc">需要先登录后才能发布游戏到首页。</p>
          </header>
          <div className="actions">
            <a className="btn" href="/login">
              去登录
            </a>
            <a className="btn btnSecondary" href="/">
              返回首页
            </a>
          </div>
        </section>
      </main>
    );
  }

  const sp = (await searchParams) || {};
  const pickedId = typeof sp.id === "string" ? sp.id : "";
  const explicitDraftId = typeof sp.draftId === "string" ? sp.draftId : "";

  // me 信息（用于作者权限：非管理员禁用 creatorId）
  let meCreatorId: string | null = null;
  let isAdmin = false;
  try {
    await ensureCreatorsAuthFields();
    await ensureGamesCoverFields();
    if (sess?.phone) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, sess.phone)).limit(1);
      meCreatorId = row?.id || null;
    } else if (sess?.openid) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, sess.openid)).limit(1);
      meCreatorId = row?.id || null;
    }
    isAdmin = isSuperAdminId(meCreatorId);
  } catch {}

  // 如果数据库里已存在该 game，则用数据库数据预填（“更新”场景）
  let initial: any = undefined;
  let existsInDb = false;
  let resolvedSourceDraftId = explicitDraftId || pickedId;
  let lockId = !!resolvedSourceDraftId;
  if (pickedId) {
    try {
      await ensureGamesCoverFields();
    } catch {}
    try {
      // 不要 select() 全字段：某些部署/旧库可能尚未补齐 cover_mime/cover_data/时间戳字段
      // 这里仅取发布表单需要的字段，避免因为“列缺失”导致页面直接崩溃。
      const [row] = await db
        .select({
          id: gamesTable.id,
          sourceDraftId: gamesTable.sourceDraftId,
          title: gamesTable.title,
          shortDesc: gamesTable.shortDesc,
          ruleText: gamesTable.ruleText,
          coverUrl: gamesTable.coverUrl,
          path: gamesTable.path,
          creatorId: gamesTable.creatorId,
        })
        .from(gamesTable)
        .where(eq(gamesTable.id, pickedId))
        .limit(1);
      if (row) {
        existsInDb = true;
        resolvedSourceDraftId = explicitDraftId || String(row.sourceDraftId || "").trim() || resolvedSourceDraftId;
        const stableId = resolvedSourceDraftId || row.id;
        initial = {
          id: stableId,
          title: row.title,
          shortDesc: row.shortDesc,
          ruleText: row.ruleText,
          creatorId: row.creatorId,
          coverUrl: row.coverUrl,
          path: stableId === row.id ? row.path : `/games/${stableId}/`,
        };
      } else {
        const [linked] = await db
          .select({
            id: gamesTable.id,
            sourceDraftId: gamesTable.sourceDraftId,
            title: gamesTable.title,
            shortDesc: gamesTable.shortDesc,
            ruleText: gamesTable.ruleText,
            coverUrl: gamesTable.coverUrl,
            path: gamesTable.path,
            creatorId: gamesTable.creatorId,
          })
          .from(gamesTable)
          .where(eq(gamesTable.sourceDraftId, pickedId))
          .limit(1);
        if (linked) {
          existsInDb = true;
          const stableId = explicitDraftId || pickedId || String(linked.sourceDraftId || "").trim() || linked.id;
          resolvedSourceDraftId = stableId;
          initial = {
            id: stableId,
            title: linked.title,
            shortDesc: linked.shortDesc,
            ruleText: linked.ruleText,
            creatorId: linked.creatorId,
            coverUrl: linked.coverUrl,
            path: `/games/${stableId}/`,
          };
        } else {
          // 新发布：沿用当前草稿 id，不再额外生成一个发布 id。
          const draftId = explicitDraftId || pickedId;
          resolvedSourceDraftId = draftId;
          const metaRaw = await readDraftFile(draftId, "meta.json");
          let meta: any = null;
          try {
            meta = metaRaw ? JSON.parse(metaRaw) : null;
          } catch {
            meta = null;
          }
          const indexHtml = await readDraftFile(draftId, "index.html");
          const title0 = String(meta?.title || "").trim() || parseTitleFromHtml(indexHtml) || "";
          const shortDesc0 = String(meta?.shortDesc || "").trim();
          const rules0 = String(meta?.rules || meta?.ruleText || "").trim();
          initial = {
            id: draftId,
            title: title0,
            shortDesc: shortDesc0,
            ruleText: rules0,
            creatorId: meCreatorId || "tianqing",
            coverUrl: title0 ? "" : "",
            path: draftId ? `/games/${draftId}/` : "",
          };
          existsInDb = false;
        }
      }
    } catch {
      // 数据库查询失败（连接/表结构/权限等）：不要让页面崩，退回草稿预填
      const draftId = explicitDraftId || pickedId;
      resolvedSourceDraftId = draftId;
      const indexHtml = await readDraftFile(draftId, "index.html");
      initial = {
        id: draftId,
        title: parseTitleFromHtml(indexHtml) || "",
        shortDesc: "",
        ruleText: "",
        creatorId: meCreatorId || "tianqing",
        path: draftId ? `/games/${draftId}/` : "",
      };
      existsInDb = false;
    }
  }
  lockId = !!resolvedSourceDraftId;

  return (
    <main className="wrap">
      <section className="card homeCard createBento">
        <header className="header">
          <h1>更新应用信息</h1>
        </header>

        <PublishForm
          defaultCreatorId="tianqing"
          sourceDraftId={resolvedSourceDraftId || undefined}
          lockId={lockId}
          initial={initial || undefined}
          meCreatorId={meCreatorId || undefined}
          isAdmin={isAdmin}
          existsInDb={existsInDb}
        />
      </section>
    </main>
  );
}
