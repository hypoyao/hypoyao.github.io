import { redirect } from "next/navigation";
import { requireAdminCreator } from "@/lib/auth/requireAdmin";
import InviteAdminClient from "./ui";

export const dynamic = "force-dynamic";

export default async function InvitesAdminPage() {
  const auth = await requireAdminCreator();
  if (!auth.ok) {
    // 未登录：去登录；已登录但非管理员：回首页
    if (auth.error === "UNAUTHORIZED") redirect(`/login?next=${encodeURIComponent("/admin/invites")}`);
    redirect("/");
  }
  return (
    <main className="wrap">
      <section className="card createCard createBento">
        <header className="header">
          <div className="homeHeaderRow">
            <h1>邀请码管理</h1>
            <div className="homeHeaderActions">
              <a className="homeCreateBtn" href="/">
                首页
              </a>
            </div>
          </div>
          <p className="desc">每个邀请码只能使用 1 次。可生成、禁用、删除。</p>
        </header>

        <InviteAdminClient />
      </section>
    </main>
  );
}

