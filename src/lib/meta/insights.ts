import "server-only";
import type { InsightRow } from "@/lib/ads/types";
import { graphGetAll } from "@/lib/meta/graph";

export type { InsightRow };

type RawInsight = {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  actions?: { action_type?: string; value?: string }[];
};

const toInt = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Meta devuelve todas las cifras como texto; aqui se convierten a tipos de verdad. */
export function normalizeInsight(raw: RawInsight): InsightRow | null {
  if (!raw.campaign_id || !raw.date_start || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date_start)) return null;

  const actions: Record<string, number> = {};
  for (const a of raw.actions ?? []) {
    const value = Number(a.value);
    if (a.action_type && Number.isFinite(value)) actions[a.action_type] = value;
  }

  return {
    date: raw.date_start,
    campaignId: raw.campaign_id,
    campaignName: raw.campaign_name || `Campaña ${raw.campaign_id}`,
    spend: /^\d+(\.\d+)?$/.test(raw.spend ?? "") ? (raw.spend as string) : "0",
    impressions: toInt(raw.impressions),
    clicks: toInt(raw.clicks),
    reach: toInt(raw.reach),
    actions: Object.keys(actions).length ? actions : null,
  };
}

/** Rendimiento diario por campaña de una cuenta publicitaria entre dos fechas (AAAA-MM-DD, ambas incluidas). */
export async function fetchCampaignInsights(
  adAccountId: string,
  token: string,
  since: string,
  until: string,
): Promise<InsightRow[]> {
  const raw = await graphGetAll<RawInsight>(`act_${adAccountId}/insights`, {
    token,
    params: {
      level: "campaign",
      fields: "campaign_id,campaign_name,spend,impressions,clicks,reach,actions",
      time_increment: 1,
      time_range: JSON.stringify({ since, until }),
      limit: 500,
    },
  });
  return raw.map(normalizeInsight).filter((r): r is InsightRow => r !== null);
}
