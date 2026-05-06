"use client";

import { useMemo, useState } from "react";
import { pickDefaultCoverUrl } from "@/lib/covers/defaultCovers";

type Props = {
  src?: string;
  fallbackKey?: string;
  alt: string;
  className?: string;
  loading?: "eager" | "lazy";
  decoding?: "async" | "sync" | "auto";
};

export default function CoverImage({ src, fallbackKey, alt, className, loading, decoding }: Props) {
  const [failed, setFailed] = useState(false);
  const fallback = useMemo(() => pickDefaultCoverUrl(fallbackKey || alt || "default"), [fallbackKey, alt]);
  const effectiveSrc = !failed && String(src || "").trim() ? String(src) : fallback;
  return (
    <img
      className={className}
      src={effectiveSrc}
      alt={alt}
      loading={loading}
      decoding={decoding}
      onError={() => setFailed(true)}
    />
  );
}

