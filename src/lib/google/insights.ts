import "server-only";
import type { InsightRow } from "@/lib/ads/types";
import { searchStream, type AdsAuth } from "@/lib/google/client";

type RawRow = {
  campaign?: { id?: string; name?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string | number; impressions?: string | number; clicks?: string | number; conversions?: number | string };
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Google manda los enteros de 64 bits como texto. */
const toInt = (v: string | number | undefined) => {
  const n = Number.parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Micros (millonesimas de la moneda) -> decimal como texto, sin perder precision ni pasar por coma flotante. */
export function microsToDecimal(micros: string | number | undefined): string {
  const s = String(micros ?? "0");
  if (!/^\d+$/.test(s)) return "0";
  const n = BigInt(s);
  const million = BigInt(1_000_000); // sin literal 1000000n: el objetivo de TypeScript del proyecto es anterior a ES2020
  return `${n / million}.${(n % million).toString().padStart(6, "0")}`;
}

/** Convierte una fila de Google Ads (camelCase) al formato comun; null si no trae lo imprescindible. */
export function normalizeInsight(raw: RawRow): InsightRow | null {
  const id = raw.campaign?.id;
  const date = raw.segments?.date;
  if (!id || !date || !ISO.test(date)) return null;
  const conversions = Number(raw.metrics?.conversions);
  return {
    date,
    campaignId: String(id),
    campaignName: raw.campaign?.name || `Campaña ${id}`,
    spend: microsToDecimal(raw.metrics?.costMicros),
    impressions: toInt(raw.metrics?.impressions),
    clicks: toInt(raw.metrics?.clicks),
    reach: 0, // Google Ads no informa el alcance por campaña y dia
    actions: Number.isFinite(conversions) && conversions > 0 ? { conversions } : null,
  };
}

/** Rendimiento diario por campaña de una cuenta entre dos fechas (AAAA-MM-DD, ambas incluidas). */
export async function fetchCampaignInsights(customerId: string, auth: AdsAuth, since: string, until: string): Promise<InsightRow[]> {
  // Las fechas van dentro de la consulta: se validan para que no se pueda colar texto.
  if (!ISO.test(since) || !ISO.test(until)) throw new Error("Fechas no validas.");
  const query =
    "SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions " +
    `FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  const rows = await searchStream<RawRow>(customerId, query, auth);
  return rows.map(normalizeInsight).filter((r): r is InsightRow => r !== null);
}
