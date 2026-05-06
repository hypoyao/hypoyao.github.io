import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { requireAdminCreator } from "@/lib/auth/requireAdmin";
import { db } from "@/lib/db";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGameEngagementTables } from "@/lib/db/ensureGameEngagementTables";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import WorksAdminUi, { type AdminWallGame } from "./ui";
import "./works-admin.css";

export const dynamic = "force-dynamic";

function rowsOf<T = any>(res: any): T[] {
  return Array.isArray(res?.rows) ? res.rows : [];
}

export default async function WorksAdminPage() {
  const auth = await requireAdminCreator();
  if (!auth.ok) {
    if (auth.error === "UNAUTHORIZED") redirect(`/login?next=${encodeURIComponent("/admin/works")}`);
    redirect("/");
  }

  await Promise.all([ensureCreatorsAuthFields(), ensureGamesCoverFields(), ensureGameEngagementTables()]);

  const rows = rowsOf(
    await db.execute(sql`
      select
        g.id,
        g.title,
        g.short_desc,
        g.cover_url,
        g.path,
        g.creator_id,
        g.show_on_wall,
        g.updated_at,
        c.name as creator_name,
        coalesce(v.play_count, 0)::int as play_count,
        coalesce(l.like_count, 0)::int as like_count
      from games g
      inner join creators c on c.id = g.creator_id
      left join (
        select game_id, count(*)::int as play_count
        from game_play_events
        group by game_id
      ) v on v.game_id = g.id
      left join (
        select game_id, count(*)::int as like_count
        from game_like_votes
        group by game_id
      ) l on l.game_id = g.id
      order by g.updated_at desc, g.created_at desc
      limit 500
    `),
  );

  const games: AdminWallGame[] = rows.map((row: any) => ({
    id: String(row.id || ""),
    title: String(row.title || ""),
    shortDesc: String(row.short_desc || ""),
    coverUrl: String(row.cover_url || ""),
    path: String(row.path || ""),
    creatorId: String(row.creator_id || ""),
    creatorName: String(row.creator_name || ""),
    playCount: Number(row.play_count || 0) || 0,
    likeCount: Number(row.like_count || 0) || 0,
    showOnWall: row.show_on_wall !== false,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : "",
  }));

  return (
    <main className="worksAdminPage">
      <WorksAdminUi initialGames={games} />
    </main>
  );
}
