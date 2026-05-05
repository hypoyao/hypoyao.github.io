import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { requireAdminCreator } from "@/lib/auth/requireAdmin";
import { db } from "@/lib/db";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { ensureCreatorUserMessagesTable } from "@/lib/db/ensureCreatorUserMessagesTable";
import { ensureGameEngagementTables } from "@/lib/db/ensureGameEngagementTables";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { ensureUsageAnalyticsTables } from "@/lib/db/ensureUsageAnalyticsTables";
import "./usage.css";

export const dynamic = "force-dynamic";

type Search = { gameId?: string; creatorId?: string };

function rowsOf<T = any>(res: any): T[] {
  return Array.isArray(res?.rows) ? res.rows : [];
}

function n(v: unknown) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function fmtTime(v: unknown) {
  if (!v) return "-";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function clip(s: unknown, max = 160) {
  const text = String(s || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text || "-";
  return `${text.slice(0, max)}…`;
}

function eventName(t: unknown) {
  const s = String(t || "");
  if (s === "draft_created") return "新建草稿";
  if (s === "game_published") return "发布游戏";
  if (s === "game_updated") return "更新游戏";
  if (s === "game_played") return "试玩游戏";
  if (s === "chat_user") return "用户发言";
  if (s === "chat_assistant") return "AI 回复";
  return s || "-";
}

function roleName(t: unknown) {
  return String(t || "") === "assistant" ? "AI" : "用户";
}

function activityTitle(t: unknown) {
  const s = String(t || "");
  if (s === "play") return "试玩游戏";
  if (s === "chat_user") return "用户发言";
  if (s === "chat_assistant") return "AI 回复";
  return eventName(s);
}

function qs(params: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `/admin/usage?${s}` : "/admin/usage";
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e || "UNKNOWN_ERROR");
}

async function safeEnsure(label: string, run: () => Promise<void>, warnings: string[]) {
  try {
    await run();
  } catch (e) {
    console.error(`[admin/usage] ensure failed: ${label}`, e);
    warnings.push(`${label} 初始化失败：${errText(e).slice(0, 120)}`);
  }
}

async function safeRows<T = any>(label: string, run: () => Promise<any>, warnings: string[]): Promise<T[]> {
  try {
    return rowsOf<T>(await run());
  } catch (e) {
    console.error(`[admin/usage] query failed: ${label}`, e);
    warnings.push(`${label} 查询失败，已降级为空数据。`);
    return [];
  }
}

export default async function UsageAdminPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const auth = await requireAdminCreator();
  if (!auth.ok) {
    if (auth.error === "UNAUTHORIZED") redirect(`/login?next=${encodeURIComponent("/admin/usage")}`);
    redirect("/");
  }

  const sp = searchParams ? await searchParams : {};
  const selectedGameId = String(sp?.gameId || "").trim().slice(0, 120);
  const selectedCreatorId = String(sp?.creatorId || "").trim().slice(0, 120);

  const warnings: string[] = [];
  await safeEnsure("用户字段", ensureCreatorsAuthFields, warnings);
  await safeEnsure("游戏字段", ensureGamesCoverFields, warnings);
  await safeEnsure("草稿表", ensureCreatorDraftTables, warnings);
  await safeEnsure("旧聊天表", ensureCreatorUserMessagesTable, warnings);
  await safeEnsure("试玩表", ensureGameEngagementTables, warnings);
  await safeEnsure("使用统计表", ensureUsageAnalyticsTables, warnings);

  const playCreatorCols = await safeRows(
    "试玩用户列检查",
    () =>
      db.execute(sql`
        select 1
        from information_schema.columns
        where table_name = 'game_play_events' and column_name = 'creator_id'
        limit 1
      `),
    warnings,
  );
  const hasPlayCreatorColumn = playCreatorCols.length > 0;

  const selectedCreatorRows = selectedCreatorId
    ? await safeRows(
        "选中用户",
        () =>
          db.execute(sql`
            select id, name, phone, created_at, updated_at
            from creators
            where id = ${selectedCreatorId}
            limit 1
          `),
        warnings,
      )
    : [];
  const selectedCreator = selectedCreatorRows[0] || null;

  const selectedCreatorStatsRows = selectedCreatorId
    ? await safeRows(
        "选中用户统计",
        () =>
          hasPlayCreatorColumn
            ? db.execute(sql`
                select
                  (select count(*)::int from games where creator_id = ${selectedCreatorId}) as published_count,
                  (select count(*)::int from creator_usage_events where creator_id = ${selectedCreatorId} and event_type = 'draft_created') as draft_created_count,
                  (select count(*)::int from game_play_events where creator_id = ${selectedCreatorId}) as play_count,
                  (select count(*)::int from creator_chat_messages where creator_id = ${selectedCreatorId}) as chat_count,
                  (select max(created_at) from creator_chat_messages where creator_id = ${selectedCreatorId}) as last_chat_at
              `)
            : db.execute(sql`
                select
                  (select count(*)::int from games where creator_id = ${selectedCreatorId}) as published_count,
                  (select count(*)::int from creator_usage_events where creator_id = ${selectedCreatorId} and event_type = 'draft_created') as draft_created_count,
                  0::int as play_count,
                  (select count(*)::int from creator_chat_messages where creator_id = ${selectedCreatorId}) as chat_count,
                  (select max(created_at) from creator_chat_messages where creator_id = ${selectedCreatorId}) as last_chat_at
              `),
        warnings,
      )
    : [];
  const selectedCreatorStats = selectedCreatorStatsRows[0] || {};

  const [summaryRows, users, plays, events, conversations] = await Promise.all([
    safeRows(
      "汇总数据",
      () =>
        selectedCreatorId
          ? hasPlayCreatorColumn
            ? db.execute(sql`
                select
                  (select count(*)::int from games where creator_id = ${selectedCreatorId}) as published_count,
                  (select count(*)::int from creator_usage_events where creator_id = ${selectedCreatorId} and event_type = 'draft_created') as draft_count,
                  (select count(*)::int from game_play_events where creator_id = ${selectedCreatorId}) as play_count,
                  (select count(*)::int from creator_chat_messages where creator_id = ${selectedCreatorId}) as chat_message_count,
                  (select count(*)::int from creator_usage_events where creator_id = ${selectedCreatorId}) as usage_event_count
              `)
            : db.execute(sql`
                select
                  (select count(*)::int from games where creator_id = ${selectedCreatorId}) as published_count,
                  (select count(*)::int from creator_usage_events where creator_id = ${selectedCreatorId} and event_type = 'draft_created') as draft_count,
                  0::int as play_count,
                  (select count(*)::int from creator_chat_messages where creator_id = ${selectedCreatorId}) as chat_message_count,
                  (select count(*)::int from creator_usage_events where creator_id = ${selectedCreatorId}) as usage_event_count
              `)
          : db.execute(sql`
              select
                (select count(*)::int from creators) as creator_count,
                (select count(*)::int from games) as published_count,
                (select count(*)::int from creator_draft_games) as draft_count,
                (select count(*)::int from game_play_events) as play_count,
                (select count(*)::int from game_like_votes) as like_count,
                (select count(*)::int from creator_user_messages) as legacy_user_message_count,
                (select count(*)::int from creator_chat_messages) as chat_message_count,
                (select count(*)::int from creator_usage_events) as usage_event_count
            `),
      warnings,
    ),
    safeRows(
      "用户使用概览",
      () =>
        hasPlayCreatorColumn
          ? db.execute(sql`
              with
                p as (
                  select creator_id, count(*)::int as play_count, max(created_at) as last_at
                  from game_play_events
                  where creator_id is not null
                  group by creator_id
                ),
                ch as (
                  select creator_id, count(*)::int as chat_count, max(created_at) as last_at
                  from creator_chat_messages
                  group by creator_id
                ),
                pub as (
                  select creator_id, count(*)::int as published_count, max(updated_at) as last_at
                  from games
                  group by creator_id
                ),
                ev as (
                  select creator_id,
                    count(*) filter (where event_type = 'draft_created')::int as draft_created_count,
                    max(created_at) as last_at
                  from creator_usage_events
                  where creator_id is not null
                  group by creator_id
                )
              select
                c.id,
                c.name,
                c.phone,
                coalesce(pub.published_count, 0)::int as published_count,
                coalesce(ev.draft_created_count, 0)::int as draft_created_count,
                coalesce(p.play_count, 0)::int as play_count,
                coalesce(ch.chat_count, 0)::int as chat_count,
                nullif(greatest(
                  coalesce(pub.last_at, timestamptz '1970-01-01'),
                  coalesce(ev.last_at, timestamptz '1970-01-01'),
                  coalesce(p.last_at, timestamptz '1970-01-01'),
                  coalesce(ch.last_at, timestamptz '1970-01-01')
                ), timestamptz '1970-01-01') as last_activity_at
              from creators c
              left join p on p.creator_id = c.id
              left join ch on ch.creator_id = c.id
              left join pub on pub.creator_id = c.id
              left join ev on ev.creator_id = c.id
              ${selectedCreatorId ? sql`where c.id = ${selectedCreatorId}` : sql``}
              order by last_activity_at desc nulls last
              limit 80
            `)
          : db.execute(sql`
              with
                ch as (
                  select creator_id, count(*)::int as chat_count, max(created_at) as last_at
                  from creator_chat_messages
                  group by creator_id
                ),
                pub as (
                  select creator_id, count(*)::int as published_count, max(updated_at) as last_at
                  from games
                  group by creator_id
                ),
                ev as (
                  select creator_id,
                    count(*) filter (where event_type = 'draft_created')::int as draft_created_count,
                    max(created_at) as last_at
                  from creator_usage_events
                  where creator_id is not null
                  group by creator_id
                )
              select
                c.id,
                c.name,
                c.phone,
                coalesce(pub.published_count, 0)::int as published_count,
                coalesce(ev.draft_created_count, 0)::int as draft_created_count,
                0::int as play_count,
                coalesce(ch.chat_count, 0)::int as chat_count,
                nullif(greatest(
                  coalesce(pub.last_at, timestamptz '1970-01-01'),
                  coalesce(ev.last_at, timestamptz '1970-01-01'),
                  coalesce(ch.last_at, timestamptz '1970-01-01')
                ), timestamptz '1970-01-01') as last_activity_at
              from creators c
              left join ch on ch.creator_id = c.id
              left join pub on pub.creator_id = c.id
              left join ev on ev.creator_id = c.id
              ${selectedCreatorId ? sql`where c.id = ${selectedCreatorId}` : sql``}
              order by last_activity_at desc nulls last
              limit 80
            `),
      warnings,
    ),
    safeRows("最近试玩", () => hasPlayCreatorColumn ? db.execute(sql`
      select
        p.id,
        p.game_id,
        p.creator_id as player_id,
        pc.name as player_name,
        p.visitor_id,
        p.created_at,
        g.title as game_title,
        g.creator_id as owner_id,
        oc.name as owner_name
      from game_play_events p
      left join games g on g.id = p.game_id
      left join creators pc on pc.id = p.creator_id
      left join creators oc on oc.id = g.creator_id
      ${selectedCreatorId ? sql`where p.creator_id = ${selectedCreatorId}` : sql``}
      order by p.created_at desc
      limit 80
    `) : db.execute(sql`
      select
        p.id,
        p.game_id,
        null::text as player_id,
        null::text as player_name,
        p.visitor_id,
        p.created_at,
        g.title as game_title,
        g.creator_id as owner_id,
        oc.name as owner_name
      from game_play_events p
      left join games g on g.id = p.game_id
      left join creators oc on oc.id = g.creator_id
      ${selectedCreatorId ? sql`where false` : sql``}
      order by p.created_at desc
      limit 80
    `), warnings),
    safeRows("最近创作发布", () => db.execute(sql`
      select
        e.id,
        e.event_type,
        e.creator_id,
        c.name as creator_name,
        e.game_id,
        coalesce(g.title, dg.title, e.game_id) as game_title,
        e.detail,
        e.created_at
      from creator_usage_events e
      left join creators c on c.id = e.creator_id
      left join games g on g.id = e.game_id
      left join creator_draft_games dg on dg.id = e.game_id
      where e.event_type in ('draft_created', 'game_published', 'game_updated')
        ${selectedCreatorId ? sql`and e.creator_id = ${selectedCreatorId}` : sql``}
      order by e.created_at desc
      limit 80
    `), warnings),
    safeRows("最近对话", () => db.execute(sql`
      select
        cm.game_id,
        cm.creator_id,
        c.name as creator_name,
        coalesce(g.title, dg.title, cm.game_id) as game_title,
        count(*)::int as message_count,
        max(cm.created_at) as last_at
      from creator_chat_messages cm
      left join creators c on c.id = cm.creator_id
      left join games g on g.id = cm.game_id
      left join creator_draft_games dg on dg.id = cm.game_id
      ${selectedCreatorId ? sql`where cm.creator_id = ${selectedCreatorId}` : sql``}
      group by cm.game_id, cm.creator_id, c.name, coalesce(g.title, dg.title, cm.game_id)
      order by last_at desc
      limit 80
    `), warnings),
  ]);

  const summary = summaryRows[0] || {};

  let selectedMessages: any[] = [];
  if (selectedGameId) {
    selectedMessages = await safeRows(
      "对话过程",
      () =>
        db.execute(sql`
          select
            cm.id,
            cm.role,
            cm.content,
            cm.created_at,
            cm.creator_id,
            c.name as creator_name
          from creator_chat_messages cm
          left join creators c on c.id = cm.creator_id
          where cm.game_id = ${selectedGameId}
            ${selectedCreatorId ? sql`and cm.creator_id = ${selectedCreatorId}` : sql``}
          order by cm.created_at asc, cm.id asc
          limit 300
        `),
      warnings,
    );
    if (!selectedMessages.length) {
      selectedMessages = await safeRows(
        "旧对话过程",
        () =>
          db.execute(sql`
            select
              id,
              'user' as role,
              content,
              created_at,
              creator_id,
              null as creator_name
            from creator_user_messages
            where game_id = ${selectedGameId}
              ${selectedCreatorId ? sql`and creator_id = ${selectedCreatorId}` : sql``}
            order by created_at asc, id asc
            limit 300
          `),
        warnings,
      );
    }
  }

  const creatorActivities = selectedCreatorId
    ? await safeRows(
        "个人流水",
        () =>
          hasPlayCreatorColumn
            ? db.execute(sql`
                select *
                from (
                  select
                    'play'::text as kind,
                    p.game_id,
                    coalesce(g.title, p.game_id) as game_title,
                    coalesce('作者：' || oc.name, '作者：' || g.creator_id, '') as detail,
                    p.created_at,
                    null::text as role
                  from game_play_events p
                  left join games g on g.id = p.game_id
                  left join creators oc on oc.id = g.creator_id
                  where p.creator_id = ${selectedCreatorId}

                  union all

                  select
                    e.event_type as kind,
                    e.game_id,
                    coalesce(g.title, dg.title, e.game_id) as game_title,
                    e.detail,
                    e.created_at,
                    null::text as role
                  from creator_usage_events e
                  left join games g on g.id = e.game_id
                  left join creator_draft_games dg on dg.id = e.game_id
                  where e.creator_id = ${selectedCreatorId}

                  union all

                  select
                    case when cm.role = 'assistant' then 'chat_assistant' else 'chat_user' end as kind,
                    cm.game_id,
                    coalesce(g.title, dg.title, cm.game_id) as game_title,
                    cm.content as detail,
                    cm.created_at,
                    cm.role
                  from creator_chat_messages cm
                  left join games g on g.id = cm.game_id
                  left join creator_draft_games dg on dg.id = cm.game_id
                  where cm.creator_id = ${selectedCreatorId}
                ) activity
                order by created_at desc
                limit 160
              `)
            : db.execute(sql`
                select *
                from (
                  select
                    e.event_type as kind,
                    e.game_id,
                    coalesce(g.title, dg.title, e.game_id) as game_title,
                    e.detail,
                    e.created_at,
                    null::text as role
                  from creator_usage_events e
                  left join games g on g.id = e.game_id
                  left join creator_draft_games dg on dg.id = e.game_id
                  where e.creator_id = ${selectedCreatorId}

                  union all

                  select
                    case when cm.role = 'assistant' then 'chat_assistant' else 'chat_user' end as kind,
                    cm.game_id,
                    coalesce(g.title, dg.title, cm.game_id) as game_title,
                    cm.content as detail,
                    cm.created_at,
                    cm.role
                  from creator_chat_messages cm
                  left join games g on g.id = cm.game_id
                  left join creator_draft_games dg on dg.id = cm.game_id
                  where cm.creator_id = ${selectedCreatorId}
                ) activity
                order by created_at desc
                limit 160
              `),
        warnings,
      )
    : [];

  const cards = selectedCreatorId
    ? [
        ["该用户发布", n(summary.published_count)],
        ["该用户新建", n(summary.draft_count)],
        ["该用户试玩", n(summary.play_count)],
        ["该用户对话", n(summary.chat_message_count)],
        ["该用户事件", n(summary.usage_event_count)],
      ]
    : [
        ["用户数", n(summary.creator_count)],
        ["发布游戏", n(summary.published_count)],
        ["草稿游戏", n(summary.draft_count)],
        ["总试玩次数", n(summary.play_count)],
        ["总点赞数", n(summary.like_count)],
        ["对话消息", n(summary.chat_message_count) || n(summary.legacy_user_message_count)],
        ["使用事件", n(summary.usage_event_count)],
      ];

  return (
    <main className="usageWrap">
      <section className="usageShell">
        <header className="usageHero">
          <div>
            <p className="usageKicker">Admin Analytics</p>
            <h1>数据看板</h1>
            <p className="usageDesc">查看用户试玩、创作、发布和 AI 对话记录。查询均限制条数并依赖索引，避免拖慢线上主链路。</p>
          </div>
          <div className="usageActions">
            <a href="/admin/invites">邀请码</a>
            <a href="/">首页</a>
          </div>
        </header>

        <section className="usageCards" aria-label="summary">
          {cards.map(([label, value]) => (
            <div className="usageCard" key={String(label)}>
              <div className="usageCardLabel">{label}</div>
              <div className="usageCardValue">{value}</div>
            </div>
          ))}
        </section>

        {warnings.length ? (
          <section className="usageWarn" aria-label="query warnings">
            <strong>部分统计已降级：</strong>
            {Array.from(new Set(warnings)).slice(0, 6).map((w) => (
              <span key={w}>{w}</span>
            ))}
          </section>
        ) : null}

        {selectedCreatorId ? (
          <section className="usagePanel usageSelected">
            <div className="usagePanelHead">
              <div>
                <h2>个人使用流水</h2>
                <p className="usagePanelDesc">
                  当前用户：{selectedCreator?.name || selectedCreatorId}
                  <span> · {selectedCreatorId}</span>
                </p>
              </div>
              <a className="usageClearLink" href="/admin/usage">
                查看全站
              </a>
            </div>
            <div className="usageMiniCards">
              <div>
                <span>发布游戏</span>
                <strong>{n(selectedCreatorStats.published_count)}</strong>
              </div>
              <div>
                <span>新建草稿</span>
                <strong>{n(selectedCreatorStats.draft_created_count)}</strong>
              </div>
              <div>
                <span>试玩次数</span>
                <strong>{n(selectedCreatorStats.play_count)}</strong>
              </div>
              <div>
                <span>对话消息</span>
                <strong>{n(selectedCreatorStats.chat_count)}</strong>
              </div>
            </div>
            <div className="usageTimeline">
              {creatorActivities.length ? (
                creatorActivities.map((a: any, idx: number) => (
                  <article className="usageTimelineItem" key={`${a.kind}-${a.game_id}-${a.created_at}-${idx}`}>
                    <div className="usageTimelineDot" aria-hidden="true" />
                    <div className="usageTimelineBody">
                      <header>
                        <span className="usageBadge">{activityTitle(a.kind)}</span>
                        {a.game_id ? (
                          <a href={qs({ creatorId: selectedCreatorId, gameId: a.game_id })}>{a.game_title || a.game_id}</a>
                        ) : (
                          <strong>{a.game_title || "-"}</strong>
                        )}
                        <time>{fmtTime(a.created_at)}</time>
                      </header>
                      <p>{clip(a.detail, 220)}</p>
                    </div>
                  </article>
                ))
              ) : (
                <p className="usageEmpty">这个用户暂时没有可展示的流水记录。</p>
              )}
            </div>
          </section>
        ) : null}

        <section className="usageGrid">
          <section className="usagePanel">
            <div className="usagePanelHead">
              <h2>用户使用概览</h2>
              <span>Top 80</span>
            </div>
            <div className="usageTableWrap">
              <table className="usageTable">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>发布</th>
                    <th>新建</th>
                    <th>试玩</th>
                    <th>对话</th>
                    <th>最近活跃</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u: any) => (
                    <tr key={u.id}>
                      <td>
                        <a href={qs({ creatorId: u.id })}>{u.name || u.id}</a>
                        <div className="usageSub">{u.id}</div>
                      </td>
                      <td>{n(u.published_count)}</td>
                      <td>{n(u.draft_created_count)}</td>
                      <td>{n(u.play_count)}</td>
                      <td>{n(u.chat_count)}</td>
                      <td>{fmtTime(u.last_activity_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="usagePanel">
            <div className="usagePanelHead">
              <h2>最近试玩</h2>
              <span>Latest 80</span>
            </div>
            <div className="usageList">
              {plays.map((p: any) => (
                <div className="usageItem" key={String(p.id)}>
                  <div>
                    <a className="usageStrong" href={`/games/${encodeURIComponent(String(p.game_id || ""))}/`}>
                      {p.game_title || p.game_id}
                    </a>
                    <div className="usageSub">
                      试玩者：{p.player_name || p.player_id || "访客"} · 作者：{p.owner_name || p.owner_id || "-"}
                    </div>
                  </div>
                  <time>{fmtTime(p.created_at)}</time>
                </div>
              ))}
            </div>
          </section>
        </section>

        <section className="usageGrid">
          <section className="usagePanel">
            <div className="usagePanelHead">
              <h2>最近创作/发布</h2>
              <span>Latest 80</span>
            </div>
            <div className="usageList">
              {events.map((e: any) => (
                <div className="usageItem" key={String(e.id)}>
                  <div>
                    <span className="usageBadge">{eventName(e.event_type)}</span>
                    <a className="usageStrong" href={e.game_id ? qs({ gameId: e.game_id, creatorId: e.creator_id }) : "#"}>
                      {e.game_title || e.game_id || "-"}
                    </a>
                    <div className="usageSub">
                      {e.creator_name || e.creator_id || "访客"} · {clip(e.detail, 80)}
                    </div>
                  </div>
                  <time>{fmtTime(e.created_at)}</time>
                </div>
              ))}
            </div>
          </section>

          <section className="usagePanel">
            <div className="usagePanelHead">
              <h2>最近对话</h2>
              <span>点击查看过程</span>
            </div>
            <div className="usageList">
              {conversations.map((c: any) => (
                <a className="usageItem usageItemLink" key={`${c.game_id}-${c.creator_id}`} href={qs({ gameId: c.game_id, creatorId: c.creator_id })}>
                  <div>
                    <span className="usageStrong">{c.game_title || c.game_id}</span>
                    <div className="usageSub">
                      {c.creator_name || c.creator_id} · {n(c.message_count)} 条消息
                    </div>
                  </div>
                  <time>{fmtTime(c.last_at)}</time>
                </a>
              ))}
            </div>
          </section>
        </section>

        <section className="usagePanel">
          <div className="usagePanelHead">
            <h2>对话过程</h2>
            <span>{selectedGameId ? selectedGameId : "从上方最近对话选择一个游戏"}</span>
          </div>
          {selectedGameId ? (
            <div className="usageChat">
              {selectedMessages.length ? (
                selectedMessages.map((m: any) => (
                  <article className={`usageChatMsg ${String(m.role) === "assistant" ? "isAi" : "isUser"}`} key={String(m.id)}>
                    <header>
                      <strong>{roleName(m.role)}</strong>
                      <span>{m.creator_name || m.creator_id || ""}</span>
                      <time>{fmtTime(m.created_at)}</time>
                    </header>
                    <p>{clip(m.content, 1200)}</p>
                  </article>
                ))
              ) : (
                <p className="usageEmpty">这个游戏暂时没有可展示的对话记录。</p>
              )}
            </div>
          ) : (
            <p className="usageEmpty">选择一条最近对话后，这里会展示完整用户/AI 对话过程。</p>
          )}
        </section>
      </section>
    </main>
  );
}
