import "server-only";
import type { AdsConnector } from "@/lib/ads/types";
import { decryptSecret } from "@/lib/crypto";
import { tiktokConfig } from "@/lib/tiktok/config";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { fetchCampaignInsights } from "@/lib/tiktok/insights";

export const tiktokConnector: AdsConnector = {
  platform: "TIKTOK",
  label: "TikTok",
  configError: () => (tiktokConfig() ? null : "TikTok Ads no está configurado en este servidor (faltan TIKTOK_APP_ID y TIKTOK_APP_SECRET)."),
  fetchInsights: (account, { since, until }) => fetchCampaignInsights(account.externalId, decryptSecret(account.accessTokenEnc!), since, until),
  classifyError: (e) => (e instanceof TikTokApiError ? { message: e.userMessage, expired: e.isAuthError } : null),
};
