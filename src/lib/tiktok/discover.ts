import "server-only";
import { tiktokRequest } from "@/lib/tiktok/client";

export type TikTokAdvertiser = {
  /** ID del anunciante (cuenta publicitaria de TikTok): un numero largo. */
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
};

export type TikTokAssets = {
  accounts: TikTokAdvertiser[];
  /** Anunciantes autorizados de los que TikTok no devolvio datos. */
  skipped: { id: string; reason: string }[];
};

export const ADVERTISER_ID_RE = /^\d{1,24}$/;
const BATCH = 50;
const MAX_ADVERTISERS = 300;

const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Datos (nombre, moneda, zona horaria) de los anunciantes que la persona autorizo. */
export async function discoverAdvertisers(accessToken: string, advertiserIds: string[]): Promise<TikTokAssets> {
  const ids = [...new Set(advertiserIds.filter((id) => ADVERTISER_ID_RE.test(id)))].slice(0, MAX_ADVERTISERS);
  const found = new Map<string, TikTokAdvertiser>();

  for (let i = 0; i < ids.length; i += BATCH) {
    const data = await tiktokRequest<{ list?: Record<string, unknown>[] }>("GET", "advertiser/info/", {
      accessToken,
      query: { advertiser_ids: ids.slice(i, i + BATCH), fields: ["advertiser_id", "name", "currency", "timezone", "status"] },
    });
    for (const a of data.list ?? []) {
      const id = String(a.advertiser_id ?? "");
      if (!ADVERTISER_ID_RE.test(id)) continue;
      found.set(id, { id, name: clean(a.name) ?? `Anunciante ${id}`, currency: clean(a.currency), timezone: clean(a.timezone) });
    }
  }

  return {
    accounts: [...found.values()],
    skipped: ids.filter((id) => !found.has(id)).map((id) => ({ id, reason: "TikTok no devolvió datos de este anunciante." })),
  };
}
