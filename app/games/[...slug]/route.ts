import { NextResponse } from "next/server";
import path from "node:path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { ensureGameFilesTables } from "@/lib/db/ensureGameFilesTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentTypeFor(p: string) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  if (ext === "html") return "text/html; charset=utf-8";
  if (ext === "css") return "text/css; charset=utf-8";
  if (ext === "js") return "application/javascript; charset=utf-8";
  if (ext === "md") return "text/markdown; charset=utf-8";
  if (ext === "json") return "application/json; charset=utf-8";
  if (ext === "svg") return "image/svg+xml; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function safeRel(rel: string) {
  const s = (rel || "").replace(/^\/+/, "");
  if (!s) return "";
  if (s.includes("..") || s.includes("\\") || s.includes(":")) return "";
  return s;
}

function stripDangerousLocalBehaviorArtifacts(html: string) {
  return String(html || "")
    .replace(/\n?\s*<style\b[^>]*data-ai-local-behavior=["']1["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\n?\s*<script\b[^>]*data-ai-local-behavior=["']1["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

function injectEmbedCleanup(html: string) {
  const src = stripDangerousLocalBehaviorArtifacts(html);
  // 只用于“嵌入模式”：把创作者/规则信息从游戏区隐藏（信息在右栏展示）
  const css =
    "<style id='embed-hide-style'>" +
    // 常见信息/按钮类名兜底
    ".creatorBadge,.gameMetaRow,.creatorMetaRow,.creatorRow,.rules,.rule,.ruleText,.rulesText," +
    ".publishBtn,.updateBtn,.publishButton,.updateButton,.publish,.update{display:none!important}" +
    // 如果某些游戏把“发布/更新”做成链接按钮，也直接隐藏
    "a[href^=\"/publish\"],a[href^=\"/publish?\"]{display:none!important}" +
    // 返回首页按钮常见结构
    ".gameFooter, a[href=\"/\"]{display:none!important}" +
    "</style>";
  const js =
    "<script>(function(){try{" +
    "function run(){" +
    "var roots=[];var h=document.querySelector('header');if(h)roots.push(h);" +
    "var hs=document.querySelectorAll('.header,.top,.topbar,.gameHeader');hs.forEach(function(x){roots.push(x)});" +
    "roots.push(document.body||document.documentElement);" +
    "var reC=/创作者\\s*[:：]/;var reR=/规则\\s*[:：]/;var reP=/(发布|更新)\\b/;var reH=/(返回首页|回到首页|返回主页|回到主页)/;" +
    "roots.forEach(function(root){" +
    "root.querySelectorAll('a,button,div,p,span,li').forEach(function(el){" +
    "var t=(el.textContent||'').trim();if(!t)return;" +
    "if(reC.test(t)||t.includes('创作者：')) el.style.display='none';" +
    "if(reR.test(t)||t.includes('规则：')) el.style.display='none';" +
    "if(reP.test(t)) el.style.display='none';" +
    "if(reH.test(t)) el.style.display='none';" +
    "if(el && el.tagName==='A'){var href=(el.getAttribute('href')||'').trim();if(href==='/'||href==='/#'||href.startsWith('/publish')) el.style.display='none';}" +
    "});" +
    "});" +
    "}" +
    // DOM 未就绪时等一等（很多旧游戏把按钮放在 body 底部）
    "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run,{once:true});}else{run();}" +
    // 兼容后续脚本动态插入（例如某些游戏运行时追加 footer）
    "try{var mo=new MutationObserver(function(){run();}); mo.observe(document.documentElement||document.body,{childList:true,subtree:true}); setTimeout(function(){try{mo.disconnect()}catch(e){}},6000);}catch(e){}" +
    "}catch(e){}})();</script>";

  if (src.includes("</head>")) {
    return src.replace("</head>", `${css}${js}</head>`);
  }
  if (src.includes("<body")) {
    return src.replace(/<body([^>]*)>/i, `<body$1>${css}${js}`);
  }
  return `${css}${js}${src}`;
}

function escHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readDraftText(gameId: string, rel: string) {
  await ensureCreatorDraftTables();
  const rows = await db.execute(sql`
    select content
    from creator_draft_files
    where game_id = ${gameId} and path = ${rel}
    limit 1
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const content = list?.[0]?.content;
  return typeof content === "string" ? content : "";
}

async function readGameText(gameId: string, rel: string) {
  await ensureGameFilesTables();
  const rows = await db.execute(sql`
    select content
    from game_files
    where game_id = ${gameId} and path = ${rel}
    limit 1
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const content = list?.[0]?.content;
  return typeof content === "string" ? content : "";
}

async function buildShellHtml(gameId: string) {
  // published meta
  let title = "";
  let shortDesc = "";
  let rules = "";
  let creatorName = "创作者";
  let creatorAvatarUrl = "/assets/avatars/user.svg";
  let creatorProfilePath = "";
  let prompt = "";
  let isPublished = false;

  // 1) 优先发布表
  try {
    const rows = await db.execute(sql`
      select g.title, g.short_desc, g.rule_text, c.name as creator_name, c.avatar_url as creator_avatar, c.profile_path as creator_profile
      from games g
      join creators c on c.id = g.creator_id
      where g.id = ${gameId}
      limit 1
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    const r: any = list?.[0] || null;
    if (r) {
      isPublished = true;
      title = String(r.title || "");
      shortDesc = String(r.short_desc || "");
      rules = String(r.rule_text || "");
      creatorName = String(r.creator_name || creatorName);
      creatorAvatarUrl = String(r.creator_avatar || creatorAvatarUrl);
      creatorProfilePath = String(r.creator_profile || "");
      // prompt/meta 优先读文件（更完整）
      prompt = (await readGameText(gameId, "prompt.md")) || "";
      const metaRaw = await readGameText(gameId, "meta.json");
      if (metaRaw) {
        try {
          const m = JSON.parse(metaRaw);
          if (m && typeof m === "object") {
            title = String((m as any).title || title);
            shortDesc = String((m as any).shortDesc || shortDesc);
            rules = String((m as any).rules || (m as any).ruleText || rules);
            const cn = String((m as any)?.creator?.name || "").trim();
            if (cn) creatorName = cn;
          }
        } catch {}
      }
    }
  } catch {}

  // 2) 若不是已发布游戏：尝试草稿 meta/prompt
  if (!title) {
    isPublished = false;
    const metaRaw = await readDraftText(gameId, "meta.json");
    if (metaRaw) {
      try {
        const m = JSON.parse(metaRaw);
        if (m && typeof m === "object") {
          title = String((m as any).title || "");
          shortDesc = String((m as any).shortDesc || "");
          rules = String((m as any).rules || (m as any).ruleText || "");
          const cn = String((m as any)?.creator?.name || "").trim();
          if (cn) creatorName = cn;
        }
      } catch {}
    }
    prompt = (await readDraftText(gameId, "prompt.md")) || "";
  }

  // 避免“简介里包含规则”导致右栏重复显示两遍：
  // - 如果 shortDesc 带 “规则：…”，优先把该段归到 rules，并从简介里移除
  try {
    const t = (shortDesc || "").trim();
    const m = t.match(/规则\s*[:：]\s*([\s\S]*)/);
    if (m) {
      const r0 = String(m[1] || "").trim();
      if (!rules && r0) rules = r0;
      shortDesc = t.slice(0, m.index || 0).trim();
    }
    if (rules && shortDesc && String(rules).trim() === String(shortDesc).trim()) shortDesc = "";
  } catch {}

  // 避免右侧出现“规则 规则：xxx”的重复（内容里开头带“规则：”）
  try {
    rules = String(rules || "")
      .replace(/^\s*规则\s*[:：]\s*/i, "")
      .trim();
  } catch {}

  const safeTitle = escHtml(title || gameId);
  const safeDesc = escHtml(shortDesc || "");
  const safeRules = escHtml(rules || "");
  const safeCreatorName = escHtml(creatorName || "创作者");
  const safePrompt = escHtml(prompt || "（暂无 prompt）");
  const creatorLink = creatorProfilePath ? escHtml(creatorProfilePath) : "";
  const safeAvatar = escHtml(creatorAvatarUrl || "/assets/avatars/user.svg");

  const rawBase = `/games/${encodeURIComponent(gameId)}/__raw/`;
  const embedBase = `/games/${encodeURIComponent(gameId)}/__embed/`;
  const rawIndex = `${rawBase}index.html`;
  const embedIndex = `${embedBase}index.html`;
  const publishHref = `/publish?id=${encodeURIComponent(gameId)}`;
  const editHref = `/create?id=${encodeURIComponent(gameId)}`;
  const actionHtml = isPublished
    ? `<a class="iconBtn" href="${escHtml(editHref)}" title="编辑" aria-label="编辑">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 20h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </a>`
    : `<a class="btnPrimary" href="${escHtml(publishHref)}" aria-label="发布">发布</a>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    :root{--bg:#f8fafc;--card:#ffffff;--line:rgba(15,23,42,.10);--text:rgba(15,23,42,.92);--muted:rgba(100,116,139,.95)}
    *{box-sizing:border-box}
    body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",Arial;background:var(--bg);color:var(--text)}
    .wrap{min-height:100dvh;display:grid;grid-template-columns:1fr 360px;gap:14px;padding:14px}
    /* 手机：变为上下两栏；iframe 高度由 JS 自适应内容（避免在固定高度里滚动） */
    @media (max-width: 980px){
      .wrap{grid-template-columns:1fr}
      .gameCard{grid-template-rows:auto auto}
      /* 不限制最大高度，但给一个较大的 min-height 作为“加载期兜底”，避免高度测量失败时只剩一行 */
      .frame{height:auto;min-height:70dvh}
    }
    .gameCard{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden;min-height:0;display:grid;grid-template-rows:auto 1fr}
    .bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.92)}
    .barTitle{display:block;font-weight:1200;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .barActions{display:flex;align-items:center;gap:8px}
    .bar a{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:12px;border:1px solid var(--line);text-decoration:none;color:inherit;background:rgba(248,250,252,1)}
    .bar a svg{width:18px;height:18px;display:block}
    .frame{width:100%;height:100%;border:0;background:white}
    .info{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:12px;min-height:0;overflow:auto}
    .infoHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
    .btnPrimary{display:inline-flex;align-items:center;justify-content:center;padding:8px 10px;border-radius:12px;border:1px solid rgba(37,99,235,.25);background:rgba(37,99,235,.10);color:rgba(15,23,42,.92);font-weight:1100;text-decoration:none;white-space:nowrap}
    .iconBtn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:12px;border:1px solid var(--line);text-decoration:none;color:inherit;background:rgba(248,250,252,1)}
    .iconBtn svg{width:18px;height:18px;display:block}
    .h{font-weight:1200;font-size:16px;margin:0 0 6px}
    .desc{color:var(--muted);font-weight:900;line-height:1.6;margin:0 0 10px}
    .block{padding:10px 0;border-top:1px solid rgba(15,23,42,.06)}
    .block:first-of-type{border-top:none}
    .label{font-size:12px;font-weight:1100;color:var(--muted);margin-bottom:6px}
    .pre{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-size:13px;line-height:1.6}
    .creator{display:flex;align-items:center;gap:10px}
    .avatar{width:36px;height:36px;border-radius:999px;border:1px solid rgba(15,23,42,.10);background:#fff;object-fit:cover}
    .creator a{color:inherit;text-decoration:none;font-weight:1100}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="gameCard" aria-label="game">
      <div class="bar">
        <div class="barTitle">${safeTitle}</div>
        <div class="barActions">
          <a href="${escHtml(rawIndex)}" target="_blank" rel="noopener noreferrer" title="在新标签页打开游戏" aria-label="在新标签页打开游戏">
            <!-- 更接近“在新窗口打开”的标准图标：方框 + 右上角外开箭头 -->
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M13.5 4.5H19.5V10.5"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M10.5 13.5L19.5 4.5"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M9 4.5H7.5C6.395 4.5 5.5 5.395 5.5 6.5V16.5C5.5 17.605 6.395 18.5 7.5 18.5H17.5C18.605 18.5 19.5 17.605 19.5 16.5V15"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </a>
          <a href="/" title="返回首页" aria-label="返回首页">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 10.5 12 3l9 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M5.5 10.5V21h13V10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M10 21v-6h4v6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </a>
        </div>
      </div>
      <iframe id="gameFrame" class="frame" src="${escHtml(embedIndex)}" title="game"></iframe>
    </section>

    <aside class="info" aria-label="info">
      <div class="infoHead">
        <h1 class="h">${safeTitle}</h1>
        ${actionHtml}
      </div>
      ${safeDesc ? `<p class="desc">${safeDesc}</p>` : ``}
      ${safeRules ? `<div class="block"><div class="label">规则</div><div class="pre">${safeRules}</div></div>` : ``}
      <div class="block">
        <div class="label">创作者</div>
        <div class="creator">
          <img class="avatar" src="${safeAvatar}" alt="avatar" />
          ${creatorLink ? `<a href="${creatorLink}">${safeCreatorName}</a>` : `<span style="font-weight:1100">${safeCreatorName}</span>`}
        </div>
      </div>
      <div class="block">
        <div class="label">创作者的 prompt</div>
        <div class="pre">${safePrompt}</div>
      </div>
    </aside>
  </main>
  <script>
    (function () {
      // 手机端：让 iframe 根据内容高度自动撑开，避免在固定高度里滚动
      try {
        var mq = window.matchMedia && window.matchMedia("(max-width: 980px)");
        function isMobile() { return !!(mq && mq.matches); }
        var f = document.getElementById("gameFrame");
        if (!f) return;
        var raf = 0;
        function resizeOnce() {
          try {
            if (!isMobile()) return;
            var doc = f.contentDocument;
            if (!doc) return;
            var h = 0;
            var de = doc.documentElement;
            var b = doc.body;
            if (de) h = Math.max(h, de.scrollHeight || 0, de.offsetHeight || 0);
            if (b) h = Math.max(h, b.scrollHeight || 0, b.offsetHeight || 0);
            // 某些旧游戏（例如扫雷）主要内容可能是 absolute/canvas，scrollHeight 会异常偏小。
            // 兜底：用元素的 boundingClientRect 估算内容“最底部”。
            if (h > 0 && h < 260 && b) {
              try {
                var win = f.contentWindow;
                var maxBottom = 0;
                // 优先找常见容器，避免遍历整棵树
                var sels = ["#board", "canvas", "#app", "main", ".wrap", ".card", ".board", ".gameBoard"];
                for (var si = 0; si < sels.length; si++) {
                  var el0 = doc.querySelector(sels[si]);
                  if (el0 && el0.getBoundingClientRect) {
                    var r0 = el0.getBoundingClientRect();
                    maxBottom = Math.max(maxBottom, r0.bottom || 0);
                  }
                }
                // 再取 body 直系子节点的 bottom（数量一般很少）
                var kids = b.children || [];
                for (var i = 0; i < kids.length; i++) {
                  var el = kids[i];
                  if (!el || !el.getBoundingClientRect) continue;
                  var r = el.getBoundingClientRect();
                  maxBottom = Math.max(maxBottom, r.bottom || 0);
                }
                // 转换为文档高度（考虑滚动）
                var y = 0;
                try { y = (win && win.scrollY) ? win.scrollY : 0; } catch (e) {}
                if (maxBottom > 0) h = Math.max(h, Math.ceil(maxBottom + y));
              } catch (e) {}
            }
            if (h > 0) {
              // 重要：不要固定加 padding，否则遇到 100vh 布局会形成“越撑越高”的正反馈循环
              var cur = 0;
              try {
                cur = parseFloat(String(f.style.height || "")) || 0;
                if (!cur) cur = (f.getBoundingClientRect && f.getBoundingClientRect().height) ? f.getBoundingClientRect().height : 0;
              } catch (e) {}
              // 小于 2px 的抖动不更新，避免频繁重排
              if (!cur || Math.abs(h - cur) >= 2) f.style.height = h + "px";
            }
          } catch (e) {}
        }
        function schedule() {
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(resizeOnce);
        }
        f.addEventListener("load", function () {
          schedule();
          // 游戏可能会动态渲染（canvas/DOM），短时间内多跑几次
          var n = 0;
          var t = setInterval(function () {
            schedule();
            n++;
            if (n >= 20) clearInterval(t); // ~10s
          }, 500);
          // 若可访问同源 DOM，则监听变化持续自适应
          try {
            var doc = f.contentDocument;
            var root = doc && (doc.body || doc.documentElement);
            if (root && window.MutationObserver) {
              var mo = new MutationObserver(function () { schedule(); });
              mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: false });
              setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 60000);
            }
          } catch (e) {}
        });
        window.addEventListener("resize", schedule);
      } catch (e) {}
    })();
  </script>
</body>
</html>`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  const parts = Array.isArray(slug) ? slug : [];
  const gameId = parts[0] || "";
  if (!gameId) return new NextResponse("Not Found", { status: 404 });

  // 兼容 /games/<id> 和 /games/<id>/ ：默认 index.html
  let rel = parts.slice(1).join("/");
  if (!rel || rel.endsWith("/")) rel = `${rel || ""}index.html`;
  // 兜底：/games/<id>/something（没扩展名）也当作目录
  if (!rel.includes(".")) rel = path.posix.join(rel, "index.html");
  rel = safeRel(rel);
  if (!rel) return new NextResponse("Not Found", { status: 404 });

  // /__raw/ 前缀：直接返回 DB 内的原始游戏文件（给 create 预览 & “仅游戏”打开用）
  const RAW_PREFIX = "__raw/";
  const isRaw = rel.startsWith(RAW_PREFIX);
  const relRaw = isRaw ? safeRel(rel.slice(RAW_PREFIX.length)) : rel;
  if (isRaw && !relRaw) return new NextResponse("Not Found", { status: 404 });

  // /__embed/ 前缀：用于“游戏区 iframe”，会对 HTML 注入隐藏创作者/规则的小补丁
  const EMBED_PREFIX = "__embed/";
  const isEmbed = rel.startsWith(EMBED_PREFIX);
  const relEmbed = isEmbed ? safeRel(rel.slice(EMBED_PREFIX.length)) : rel;
  if (isEmbed && !relEmbed) return new NextResponse("Not Found", { status: 404 });

  // wrapper：只有 index.html（非 raw）返回两栏布局，其他资源仍然按原路径读取
  if (!isRaw && rel === "index.html") {
    const html = await buildShellHtml(gameId);
    return new NextResponse(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0, must-revalidate",
        pragma: "no-cache",
        "x-game-shell": "1",
        "x-shell-version": "shell-v2",
      },
    });
  }

  // 1) creator 草稿：从 DB 读取（如果存在则优先）
  await ensureCreatorDraftTables();
  const draftRows = await db.execute(sql`
    select content
    from creator_draft_files
    where game_id = ${gameId} and path = ${isRaw ? relRaw : isEmbed ? relEmbed : rel}
    limit 1
  `);
  const draftList = Array.isArray((draftRows as any).rows) ? (draftRows as any).rows : [];
  const draftContent = draftList?.[0]?.content;
  if (typeof draftContent === "string") {
    const contentOut =
      (isEmbed || isRaw) && (isEmbed ? relEmbed : relRaw || "").toLowerCase().endsWith(".html")
        ? isEmbed
          ? injectEmbedCleanup(draftContent)
          : stripDangerousLocalBehaviorArtifacts(draftContent)
        : draftContent;
    return new NextResponse(contentOut, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(isRaw ? relRaw : isEmbed ? relEmbed : rel),
        "cache-control": "no-store",
        "x-game-source": "creator_draft_files",
      },
    });
  }

  // 如果草稿存在但还没有任何文件：对 index.html 给一个可用占位页面，避免预览 404
  if ((isRaw ? relRaw : rel) === "index.html") {
    const draftGame = await db.execute(sql`
      select 1
      from creator_draft_games
      where id = ${gameId}
      limit 1
    `);
    const drows = Array.isArray((draftGame as any).rows) ? (draftGame as any).rows : [];
    if (drows.length) {
      const html =
        "<!doctype html><html lang='zh-CN'><head><meta charset='UTF-8'/>" +
        "<meta name='viewport' content='width=device-width,initial-scale=1.0'/>" +
        "<title>草稿未初始化</title>" +
        "<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:#f8fafc}" +
        ".wrap{max-width:860px;margin:24px auto;padding:0 16px}.card{background:#fff;border:1px solid rgba(15,23,42,.10);" +
        "border-radius:16px;padding:16px}h1{margin:0 0 8px;font-size:18px}p{margin:0;color:rgba(15,23,42,.75);line-height:1.6}" +
        "</style></head><body><div class='wrap'><div class='card'>" +
        "<h1>这个草稿还没有生成文件</h1>" +
        "<p>请回到 create 页面，在左侧发一句话让 AI 生成/修改游戏，预览就会自动出现。</p>" +
        "</div></div></body></html>";
      return new NextResponse(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }

  // 2) 已发布游戏：从 DB 读取（统一入口）
  await ensureGameFilesTables();
  const rows = await db.execute(sql`
    select content
    from game_files
    where game_id = ${gameId} and path = ${isRaw ? relRaw : isEmbed ? relEmbed : rel}
    limit 1
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const content = list?.[0]?.content;
  if (typeof content === "string") {
    const contentOut =
      (isEmbed || isRaw) && (isEmbed ? relEmbed : relRaw || "").toLowerCase().endsWith(".html")
        ? isEmbed
          ? injectEmbedCleanup(content)
          : stripDangerousLocalBehaviorArtifacts(content)
        : content;
    return new NextResponse(contentOut, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(isRaw ? relRaw : isEmbed ? relEmbed : rel),
        // 生产环境可改为更激进缓存；开发期先 no-store，避免调试时缓存不生效
        "cache-control": "no-store",
        "x-game-source": "game_files",
      },
    });
  }
  return new NextResponse("Not Found", { status: 404 });
}
