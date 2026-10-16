import "server-only";
import type { AdsConnector } from "@/lib/ads/types";
import { decryptSecret } from "@/lib/crypto";
import { metaConfig } from "@/lib/meta/config";
import { MetaApiError } from "@/lib/meta/errors";
import { fetchCampaignInsights } from "@/lib/meta/insights";

export const metaConnector: AdsConnector = {
  platform: "META",
  label: "Meta",
  configError: () => (metaConfig() ? null : "Meta no está configurado en este servidor (faltan META_APP_ID y META_APP_SECRET)."),
  fetchInsights: (account, { since, until }) => fetchCampaignInsights(account.externalId, decryptSecret(account.accessTokenEnc!), since, until),
  classifyError: (e) => (e instanceof MetaApiError ? { message: e.userMessage, expired: e.isAuthError } : null),
};
