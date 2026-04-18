"use client";

import { useMemo, useRef, useState } from "react";

type Props = {
  initial: {
    name: string;
    avatarUrl: string;
    gender: string | null;
    age: number | null;
    city: string | null;
  };
  profilePath: string;
};

export default function ProfileEditForm({ initial, profilePath }: Props) {
  const [name, setName] = useState(initial.name || "");
  const defaultAvatar = initial.avatarUrl || "/assets/avatars/user.svg";
  const [avatarUrl, setAvatarUrl] = useState(defaultAvatar);
  const [gender, setGender] = useState(initial.gender || "保密");
  const [age, setAge] = useState(String(initial.age || ""));
  const [city, setCity] = useState(initial.city || "");
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const payload = useMemo(
    () => ({
      name,
      avatarUrl,
      gender,
      age,
      city,
    }),
    [name, avatarUrl, gender, age, city],
  );

  async function cropToSquareDataUrl(file: File) {
    // 自动居中裁剪为正方形，并缩放到 256x256
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("READ_FAILED"));
      fr.readAsDataURL(file);
    });

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("IMG_LOAD_FAILED"));
      el.src = dataUrl;
    });

    const size = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const sx = Math.floor(((img.naturalWidth || img.width) - size) / 2);
    const sy = Math.floor(((img.naturalHeight || img.height) - size) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("NO_CANVAS");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256);

    // 优先 webp，失败则退回 png
    try {
      return canvas.toDataURL("image/webp", 0.86);
    } catch {
      return canvas.toDataURL("image/png");
    }
  }

  async function onPickLocalAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setMsg("正在处理头像…");
    try {
      const url = await cropToSquareDataUrl(f);
      setAvatarUrl(url);
      setMsg("已选择本地头像（已自动裁剪）。");
    } catch {
      setMsg("头像处理失败，请换一张图片再试。");
    } finally {
      // 允许再次选择同一文件
      e.target.value = "";
    }
  }

  async function onSave() {
    setMsg("保存中…");
    const r = await fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setMsg(`保存失败：${data?.error || r.status}`);
      return;
    }
    setMsg("保存成功，正在返回…");
    window.location.href = data?.profilePath || profilePath || "/";
  }

  return (
    <section className="creatorCard" aria-label="edit profile">
      <div className="creatorHead" style={{ paddingBottom: 8 }}>
        <img className="creatorAvatar" src={avatarUrl || "/assets/avatars/user.svg"} alt="头像预览" />
        <div className="creatorInfo">
          <div className="creatorName">编辑资料</div>
          <div className="creatorTag">完善信息，让你的个人主页更完整。</div>
        </div>
      </div>

      <div className="profileForm">
        <label className="profileField">
          <div className="profileLabel">用户名</div>
          <input className="restInput" value={name} onChange={(e) => setName(e.target.value)} placeholder="输入一个可爱的名字" />
        </label>

        <label className="profileField">
          <div className="profileLabel">头像</div>
          <div className="profileAvatarRow">
            <button type="button" className="profileAvatarPick" onClick={() => fileRef.current?.click()}>
              选择本地图片
            </button>
            <button
              type="button"
              className={`profileAvatarPick ${avatarUrl === defaultAvatar ? "isOn" : ""}`}
              onClick={() => setAvatarUrl(defaultAvatar)}
            >
              恢复默认
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={onPickLocalAvatar}
            style={{ display: "none" }}
            aria-label="选择本地头像"
          />
        </label>

        <div className="profileGrid">
          <label className="profileField">
            <div className="profileLabel">性别</div>
            <select className="restInput" value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="保密">保密</option>
              <option value="男">男</option>
              <option value="女">女</option>
              <option value="其他">其他</option>
            </select>
          </label>

          <label className="profileField">
            <div className="profileLabel">年龄</div>
            <input className="restInput" value={age} onChange={(e) => setAge(e.target.value)} placeholder="例如 8" inputMode="numeric" />
          </label>

          <label className="profileField">
            <div className="profileLabel">城市</div>
            <input className="restInput" value={city} onChange={(e) => setCity(e.target.value)} placeholder="例如 上海" />
          </label>
        </div>

        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn" type="button" onClick={onSave}>
            保存
          </button>
          <a className="btn btnGray" href={profilePath}>
            取消
          </a>
        </div>

        {msg ? <div className="profileMsg">{msg}</div> : null}
      </div>
    </section>
  );
}
