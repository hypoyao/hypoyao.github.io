import { getSession } from "@/lib/auth/session";
import PublishForm from "./PublishForm";
import { db } from "@/lib/db";
import { creators, games as gamesTable } from "@/lib/db/schema";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { isSuperAdminId } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

async function listLocalGameIds() {
  const dir = path.join(process.cwd(), "public", "games");
  const ents = await fs.readdir(dir, { withFileTypes: true });
  return ents.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function getLocalGameCreatorId(id: string) {
  try {
    const file = path.join(process.cwd(), "public", "games", id, "index.html");
    const html = await fs.readFile(file, "utf8");
    const m = html.match(/class="creatorBadge"[^>]*href="\/creators\/([^"?#/]+)"/i);
    return (m?.[1] || "").trim();
  } catch {
    return "";
  }
}

async function getGameDefaults(id: string) {
  // 从 public/games/<id>/index.html 解析默认标题/描述
  try {
    const file = path.join(process.cwd(), "public", "games", id, "index.html");
    const html = await fs.readFile(file, "utf8");
    const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || "").trim();
    const descHtml = html.match(/<p\s+class="desc"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
    const desc = descHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      id,
      title: title || id,
      shortDesc: desc ? desc.slice(0, 42) : "",
      ruleText: desc || "",
      coverUrl: `/assets/screenshots/${id}.png`,
      path: `/games/${id}/`,
    };
  } catch {
    return {
      id,
      title: id,
      shortDesc: "",
      ruleText: "",
      coverUrl: `/assets/screenshots/${id}.png`,
      path: `/games/${id}/`,
    };
  }
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

  const published = await db.select({ id: gamesTable.id }).from(gamesTable);
  const publishedIds = new Set(published.map((x) => x.id));
  const localIds = await listLocalGameIds();
  let unpublished = localIds.filter((id) => !publishedIds.has(id));

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

  // 未发布的本地小游戏：仅管理员或作者可见
  if (!isAdmin) {
    const pairs = await Promise.all(unpublished.map(async (gid) => [gid, await getLocalGameCreatorId(gid)] as const));
    unpublished = pairs.filter(([, cid]) => cid && meCreatorId && cid === meCreatorId).map(([gid]) => gid);
  }

  // 如果数据库里已存在该 game，则用数据库数据预填（“更新”场景）
  let initial: any = undefined;
  let existsInDb = false;
  if (pickedId) {
    try {
      await ensureGamesCoverFields();
    } catch {}
    const [row] = await db.select().from(gamesTable).where(eq(gamesTable.id, pickedId)).limit(1);
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
      initial = await getGameDefaults(pickedId);
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
          initial={initial || undefined}
          meCreatorId={meCreatorId || undefined}
          isAdmin={isAdmin}
          existsInDb={existsInDb}
        />
      </section>
    </main>
  );
}
