function cleanEnv(value?: string | null) {
  return String(value || "").trim();
}

export const LEGAL_EFFECTIVE_DATE = "2026-04-28";

export function getLegalConfig() {
  const currentYear = new Date().getFullYear();
  const siteName = "奇点小匠";
  const operatorName = cleanEnv(process.env.NEXT_PUBLIC_OPERATOR_NAME) || "广州奇点小匠有限责任公司";
  const contactEmail = cleanEnv(process.env.NEXT_PUBLIC_LEGAL_EMAIL) || "hypoyao@qq.com";
  const governingLaw = cleanEnv(process.env.NEXT_PUBLIC_GOVERNING_LAW) || "中华人民共和国法律";
  const disputeForum = cleanEnv(process.env.NEXT_PUBLIC_DISPUTE_FORUM) || "广州市有管辖权的人民法院";
  const copyrightLine = cleanEnv(process.env.NEXT_PUBLIC_COPYRIGHT_LINE) || `© ${currentYear} ${siteName}. All rights reserved.`;
  const icpBeian = cleanEnv(process.env.NEXT_PUBLIC_ICP_BEIAN);
  const publicSecurityBeian = cleanEnv(process.env.NEXT_PUBLIC_PUBLIC_SECURITY_BEIAN);
  const publicSecurityBeianLink = cleanEnv(process.env.NEXT_PUBLIC_PUBLIC_SECURITY_BEIAN_LINK);

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
  };
}
