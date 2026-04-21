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
        initial = {
          id: row.id,
          title: row.title,
          shortDesc: row.shortDesc,
          ruleText: row.ruleText,
          creatorId: row.creatorId,
          coverUrl: row.coverUrl,
          path: row.path,
        };
      } else {
        // 新发布：从草稿 meta/index.html 预填标题/简介/规则（id 由用户手动填）
        const metaRaw = await readDraftFile(pickedId, "meta.json");
        let meta: any = null;
        try {
          meta = metaRaw ? JSON.parse(metaRaw) : null;
        } catch {
          meta = null;
        }
        const indexHtml = await readDraftFile(pickedId, "index.html");
        const title0 = String(meta?.title || "").trim() || parseTitleFromHtml(indexHtml) || "";
        const shortDesc0 = String(meta?.shortDesc || "").trim();
        const rules0 = String(meta?.rules || meta?.ruleText || "").trim();
        initial = {
          id: "",
          title: title0,
          shortDesc: shortDesc0,
          ruleText: rules0,
          creatorId: meCreatorId || "tianqing",
          coverUrl: title0 ? "" : "",
          path: "",
        };
        existsInDb = false;
      }
    } catch {
      // 数据库查询失败（连接/表结构/权限等）：不要让页面崩，退回草稿预填
      const indexHtml = await readDraftFile(pickedId, "index.html");
      initial = { id: "", title: parseTitleFromHtml(indexHtml) || "", shortDesc: "", ruleText: "", creatorId: meCreatorId || "tianqing" };
      existsInDb = false;
    }
  }

  return (
    <main className="wrap">
      <section className="card homeCard createBento">
        <header className="header">
          <h1>更新应用信息</h1>
        </header>

        <PublishForm
          defaultCreatorId="tianqing"
          sourceDraftId={pickedId || undefined}
          initial={initial || undefined}
          meCreatorId={meCreatorId || undefined}
          isAdmin={isAdmin}
          existsInDb={existsInDb}
        />
      </section>
    </main>
  );
}
