import "server-only";
import type { InsightRow } from "@/lib/ads/types";
import { addDays } from "@/lib/meta/dates";
import { tiktokRequest } from "@/lib/tiktok/client";
import { ADVERTISER_ID_RE } from "@/lib/tiktok/discover";

/** TikTok limita los reportes diarios a 30 dias por consulta: un periodo mas largo se pide por tramos. */
const MAX_SPAN_DAYS = 30;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

type RawRow = {
  dimensions?: { campaign_id?: string; stat_time_day?: string };
  metrics?: { campaign_name?: string; spend?: string; impressions?: string; clicks?: string; reach?: string; conversion?: string };
};

const toInt = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Parte [since, until] en tramos de a lo mas `span` dias (AAAA-MM-DD, ambos extremos incluidos). */
export function dateChunks(since: string, until: string, span = MAX_SPAN_DAYS): [string, string][] {
  const out: [string, string][] = [];
  for (let start = since; start <= until; start = addDays(start, span)) {
    const end = addDays(start, span - 1);
    out.push([start, end < until ? end : until]);
  }
  return out;
}

/** Convierte una fila del reporte de TikTok al formato comun; null si no trae lo imprescindible. */
export function normalizeRow(raw: RawRow): InsightRow | null {
  const id = raw.dimensions?.campaign_id;
  // TikTok manda la fecha como «2026-10-01 00:00:00».
  const date = raw.dimensions?.stat_time_day?.slice(0, 10);
  if (!id || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const m = raw.metrics ?? {};
  const conversions = Number(m.conversion);
  return {
    date,
    campaignId: String(id),
    campaignName: m.campaign_name || `Campaña ${id}`,
    spend: /^\d+(\.\d+)?$/.test(m.spend ?? "") ? (m.spend as string) : "0",
    impressions: toInt(m.impressions),
    clicks: toInt(m.clicks),
    reach: toInt(m.reach),
    actions: Number.isFinite(conversions) && conversions > 0 ? { conversions } : null,
  };
}

/** Rendimiento diario por campaña de un anunciante entre dos fechas (AAAA-MM-DD, ambas incluidas). */
export async function fetchCampaignInsights(advertiserId: string, accessToken: string, since: string, until: string): Promise<InsightRow[]> {
  if (!ADVERTISER_ID_RE.test(advertiserId)) throw new Error("ID de anunciante de TikTok no valido.");
  const rows: InsightRow[] = [];

  for (const [start, end] of dateChunks(since, until)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await tiktokRequest<{ list?: RawRow[]; page_info?: { total_page?: number } }>("GET", "report/integrated/get/", {
        accessToken,
        query: {
          advertiser_id: advertiserId,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: ["campaign_id", "stat_time_day"],
          metrics: ["campaign_name", "spend", "impressions", "clicks", "reach", "conversion"],
          start_date: start,
          end_date: end,
          page,
          page_size: PAGE_SIZE,
        },
      });
      for (const raw of data.list ?? []) {
        const row = normalizeRow(raw);
        if (row) rows.push(row);
      }
      if (page >= (data.page_info?.total_page ?? 1)) break;
    }
  }
  return rows;
}
