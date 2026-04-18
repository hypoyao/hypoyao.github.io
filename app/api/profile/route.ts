import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normText(s: unknown, max = 40) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, max);
}

function isAllowedAvatarUrl(s: string) {
  if (!s) return true;
  if (s.startsWith("/")) return true;
  // 允许 dataURL（本地头像裁剪后上传到 DB）
  if (/^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(s)) return true;
  return false;
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess?.phone) return json(401, { ok: false, error: "UNAUTHORIZED" });

  let body: { name?: string; avatarUrl?: string; gender?: string; age?: number | string; city?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const name = normText(body.name, 20);
  // dataURL 会比较长，允许更大长度
  const avatarUrl = normText(body.avatarUrl, 220_000);
  const genderRaw = normText(body.gender, 10);
  const city = normText(body.city, 20);
  const ageNum = Number(body.age);
  const age = Number.isFinite(ageNum) && ageNum > 0 && ageNum <= 120 ? Math.floor(ageNum) : null;

  // gender 仅允许少数枚举（否则置空）
  const allowedGender = new Set(["男", "女", "其他", "保密", ""]);
  const gender = allowedGender.has(genderRaw) ? (genderRaw || null) : null;

  if (!name) return json(400, { ok: false, error: "INVALID_NAME" });
  if (!isAllowedAvatarUrl(avatarUrl)) return json(400, { ok: false, error: "INVALID_AVATAR_URL" });

  try {
    await ensureCreatorsAuthFields();
  } catch {
    return json(500, { ok: false, error: "DB_MIGRATION_FAILED" });
  }

  // 定位当前用户对应的 creator
  const [row] = await db
    .select({ id: creators.id })
    .from(creators)
    .where(eq(creators.phone, sess.phone))
    .limit(1);
  if (!row?.id) return json(404, { ok: false, error: "CREATOR_NOT_FOUND" });

  try {
    await db
      .update(creators)
      .set({
        name,
        avatarUrl: avatarUrl || "/assets/avatars/user.svg",
        gender,
        age,
        city: city || null,
        updatedAt: new Date(),
      })
      .where(eq(creators.id, row.id));
  } catch {
    return json(500, { ok: false, error: "DB_UPDATE_FAILED" });
  }

  return json(200, { ok: true, creatorId: row.id, profilePath: `/creators/${row.id}` });
}
