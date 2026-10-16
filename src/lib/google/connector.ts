import "server-only";
import type { AdsConnector } from "@/lib/ads/types";
import { googleConfig } from "@/lib/google/config";
import { accessTokenFor, loginCustomerIdOf } from "@/lib/google/connection";
import { GoogleApiError } from "@/lib/google/errors";
import { fetchCampaignInsights } from "@/lib/google/insights";

export const googleConnector: AdsConnector = {
  platform: "GOOGLE_ADS",
  label: "Google Ads",
  configError: () => (googleConfig() ? null : "Google Ads no está configurado en este servidor (faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET)."),
  fetchInsights: async (account, { since, until }) => {
    const accessToken = await accessTokenFor(account);
    return fetchCampaignInsights(account.externalId, { accessToken, loginCustomerId: loginCustomerIdOf(account) }, since, until);
  },
  classifyError: (e) => (e instanceof GoogleApiError ? { message: e.userMessage, expired: e.isAuthError } : null),
};
