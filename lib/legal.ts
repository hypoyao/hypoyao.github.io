function cleanEnv(value?: string | null) {
  return String(value || "").trim();
}

export const LEGAL_EFFECTIVE_DATE = "2026-04-28";

export function getLegalConfig() {
  const currentYear = new Date().getFullYear();
  const siteName = "奇点小匠";
  const operatorName = cleanEnv(process.env.NEXT_PUBLIC_OPERATOR_NAME) || "奇点小匠项目团队（正式上线前请补充运营主体全称）";
  const contactEmail = cleanEnv(process.env.NEXT_PUBLIC_LEGAL_EMAIL) || "legal@example.com（正式上线前请替换为真实邮箱）";
  const governingLaw = cleanEnv(process.env.NEXT_PUBLIC_GOVERNING_LAW) || "运营主体所在地适用法律（正式上线前请补充）";
  const disputeForum =
    cleanEnv(process.env.NEXT_PUBLIC_DISPUTE_FORUM) || "运营主体所在地有管辖权的人民法院或仲裁机构（正式上线前请补充）";
  const copyrightLine = cleanEnv(process.env.NEXT_PUBLIC_COPYRIGHT_LINE) || `© ${currentYear} ${siteName}. All rights reserved.`;
  const icpBeian = cleanEnv(process.env.NEXT_PUBLIC_ICP_BEIAN);
  const publicSecurityBeian = cleanEnv(process.env.NEXT_PUBLIC_PUBLIC_SECURITY_BEIAN);
  const publicSecurityBeianLink = cleanEnv(process.env.NEXT_PUBLIC_PUBLIC_SECURITY_BEIAN_LINK);

  const hasPlaceholder =
    operatorName.includes("请补充") ||
    contactEmail.includes("请替换") ||
    governingLaw.includes("请补充") ||
    disputeForum.includes("请补充");

  return {
    siteName,
    operatorName,
    contactEmail,
    governingLaw,
    disputeForum,
    copyrightLine,
    icpBeian,
    publicSecurityBeian,
    publicSecurityBeianLink,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    minimumAge: 13,
    hasPlaceholder,
  };
}
