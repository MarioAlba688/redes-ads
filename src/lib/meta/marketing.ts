import "server-only";
import { MetaApiError } from "@/lib/meta/errors";
import { graphGet, graphPost } from "@/lib/meta/graph";
import {
  STANDARD_ENHANCEMENTS_ERROR,
  adBody,
  adSetBody,
  campaignBody,
  withStandardEnhancementsOptOut,
  type GraphBody,
} from "@/lib/promotions/mapping";
import type { PromotionObjectiveName } from "@/lib/promotions/types";

// Marketing API de Meta: crear y administrar campañas, conjuntos de anuncios y anuncios. Cada funcion es una llamada
// (o dos) y no decide nada: el tope de gasto, la aprobacion y la reversion de lo creado a medias viven en
// src/lib/promotions/service.ts. Todo se crea en pausa (ver mapping.ts).

/** La cuenta publicitaria y el token de la persona que la conecto (con ads_management). */
export type AdAuth = { accountId: string; token: string };

const act = (a: AdAuth) => `act_${a.accountId}`;

async function create(path: string, token: string, body: GraphBody, what: string): Promise<string> {
  const res = await graphPost<{ id?: string }>(path, { token, params: body });
  if (!res.id) throw new MetaApiError({ message: `Meta no devolvió el id de ${what}.` });
  return String(res.id);
}

export const createCampaign = (a: AdAuth, name: string, objective: PromotionObjectiveName) =>
  create(`${act(a)}/campaigns`, a.token, campaignBody(name, objective), "la campaña");

export const createAdSet = (a: AdAuth, body: Parameters<typeof adSetBody>[0]) =>
  create(`${act(a)}/adsets`, a.token, adSetBody(body), "el conjunto de anuncios");

export const createAd = (a: AdAuth, name: string, adSetId: string, creativeId: string) =>
  create(`${act(a)}/ads`, a.token, adBody(name, adSetId, creativeId), "el anuncio");

/**
 * Creativo (lo que se ve). Si Meta pide decidir sobre sus «mejoras estandar» se repite una vez sin ellas: esas mejoras
 * cambian texto o imagen sin avisar y aqui no se quieren.
 */
export async function createCreative(a: AdAuth, body: GraphBody): Promise<string> {
  try {
    return await create(`${act(a)}/adcreatives`, a.token, body, "el creativo");
  } catch (e) {
    if (e instanceof MetaApiError && STANDARD_ENHANCEMENTS_ERROR.test(e.message)) {
      return create(`${act(a)}/adcreatives`, a.token, withStandardEnhancementsOptOut(body), "el creativo");
    }
    throw e;
  }
}

/** Sube una imagen a la cuenta publicitaria y devuelve su hash (lo que se usa en el creativo). */
export async function uploadAdImage(a: AdAuth, image: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<string> {
  const res = await graphPost<{ images?: Record<string, { hash?: string }> }>(`${act(a)}/adimages`, {
    token: a.token,
    file: { field: "filename", bytes: image.bytes, filename: image.filename, mimeType: image.mimeType },
  });
  const hash = Object.values(res.images ?? {})[0]?.hash;
  if (!hash) throw new MetaApiError({ message: "Meta no devolvió el código de la imagen." });
  return hash;
}

export type ObjectStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";

/** Cambia el estado de una campaña, un conjunto de anuncios o un anuncio. */
export async function setStatus(token: string, id: string, status: ObjectStatus): Promise<void> {
  await graphPost<{ success?: boolean }>(id, { token, params: { status } });
}

/** Estado de cualquier objeto de anuncios (campaña, conjunto o anuncio): el que se le puso y el efectivo que informa Meta. */
export async function readStatus(token: string, id: string): Promise<{ status: string | null; effectiveStatus: string | null }> {
  const r = await graphGet<{ status?: string; effective_status?: string }>(id, { token, params: { fields: "status,effective_status" } });
  return { status: r.status ?? null, effectiveStatus: r.effective_status ?? null };
}

/** Cambia el presupuesto diario de una campaña o de un conjunto de anuncios (en unidades minimas de la moneda de la cuenta). */
export async function setDailyBudget(token: string, id: string, dailyBudgetMinor: number): Promise<void> {
  await graphPost<{ success?: boolean }>(id, { token, params: { daily_budget: dailyBudgetMinor } });
}

/** Presupuesto diario que tiene ahora una campaña o un conjunto de anuncios (unidades minimas), o null si no tiene. */
export async function readDailyBudget(token: string, id: string): Promise<number | null> {
  const r = await graphGet<{ daily_budget?: string | number }>(id, { token, params: { fields: "daily_budget" } });
  return toInt(r.daily_budget);
}

/** Fija cuando termina un conjunto de anuncios. */
export async function setAdSetEnd(token: string, adSetId: string, endsAt: Date): Promise<void> {
  await graphPost<{ success?: boolean }>(adSetId, { token, params: { end_time: Math.floor(endsAt.getTime() / 1000) } });
}

export type AdSetInfo = {
  id: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  campaignId: string | null;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  endTime: string | null;
};

type RawAdSet = {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  campaign_id?: string;
  daily_budget?: string | number;
  lifetime_budget?: string | number;
  end_time?: string;
};

const ADSET_FIELDS = "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,end_time";

const toInt = (v: string | number | undefined | null): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const toAdSet = (r: RawAdSet): AdSetInfo => ({
  id: String(r.id),
  name: r.name ?? null,
  status: r.status ?? null,
  effectiveStatus: r.effective_status ?? null,
  campaignId: r.campaign_id ?? null,
  dailyBudgetMinor: toInt(r.daily_budget),
  lifetimeBudgetMinor: toInt(r.lifetime_budget),
  endTime: r.end_time ?? null,
});

export async function readAdSet(token: string, id: string): Promise<AdSetInfo> {
  return toAdSet(await graphGet<RawAdSet>(id, { token, params: { fields: ADSET_FIELDS } }));
}

export type AdInfo = { id: string; name: string | null; status: string | null; effectiveStatus: string | null; adSetId: string | null; campaignId: string | null };

type RawAd = { id: string; name?: string; status?: string; effective_status?: string; adset_id?: string; campaign_id?: string };
const AD_FIELDS = "id,name,status,effective_status,adset_id,campaign_id";
const toAd = (r: RawAd): AdInfo => ({
  id: String(r.id),
  name: r.name ?? null,
  status: r.status ?? null,
  effectiveStatus: r.effective_status ?? null,
  adSetId: r.adset_id ?? null,
  campaignId: r.campaign_id ?? null,
});

export async function readAd(token: string, id: string): Promise<AdInfo> {
  return toAd(await graphGet<RawAd>(id, { token, params: { fields: AD_FIELDS } }));
}

// ---------------------------------------------------------------------------
// Lo que ya existe en la cuenta publicitaria (para administrarlo)
// ---------------------------------------------------------------------------

export type CampaignInfo = {
  id: string;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
};

type RawCampaign = { id: string; name?: string; status?: string; effective_status?: string; objective?: string; daily_budget?: string | number; lifetime_budget?: string | number };

type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };

/** Recorre hasta `maxPages` paginas de `limit` (por defecto 3 x 100): una cuenta enorme no debe colgar la pantalla. */
async function listPaged<T>(path: string, token: string, fields: string, maxPages = 3): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await graphGet<Paged<T>>(path, { token, params: { fields, limit: 100, after } });
    items.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export type AccountObjects = {
  campaigns: CampaignInfo[];
  adSets: AdSetInfo[];
  ads: AdInfo[];
  truncated: boolean;
};

/** Campañas, conjuntos de anuncios y anuncios de la cuenta (los eliminados no aparecen). */
export async function listAccountObjects(a: AdAuth): Promise<AccountObjects> {
  const [campaigns, adSets, ads] = await Promise.all([
    listPaged<RawCampaign>(`${act(a)}/campaigns`, a.token, "id,name,status,effective_status,objective,daily_budget,lifetime_budget"),
    listPaged<RawAdSet>(`${act(a)}/adsets`, a.token, ADSET_FIELDS),
    listPaged<RawAd>(`${act(a)}/ads`, a.token, AD_FIELDS),
  ]);
  return {
    campaigns: campaigns.items.map((c) => ({
      id: String(c.id),
      name: c.name ?? null,
      status: c.status ?? null,
      effectiveStatus: c.effective_status ?? null,
      objective: c.objective ?? null,
      dailyBudgetMinor: toInt(c.daily_budget),
      lifetimeBudgetMinor: toInt(c.lifetime_budget),
    })),
    adSets: adSets.items.map(toAdSet),
    ads: ads.items.map(toAd),
    truncated: campaigns.truncated || adSets.truncated || ads.truncated,
  };
}

// ---------------------------------------------------------------------------
// Busqueda de intereses y ciudades para la segmentacion
// ---------------------------------------------------------------------------

export type InterestResult = { id: string; name: string; path: string | null };
export type CityResult = { key: string; name: string; region: string | null; countryCode: string };

/** Intereses de Meta que coinciden con lo escrito (`type=adinterest`). */
export async function searchInterests(token: string, q: string, limit = 10): Promise<InterestResult[]> {
  const res = await graphGet<{ data?: { id: string | number; name?: string; path?: string[] }[] }>("search", {
    token,
    params: { type: "adinterest", q, limit },
  });
  return (res.data ?? [])
    .filter((r) => r.id !== undefined && r.name)
    .map((r) => ({ id: String(r.id), name: String(r.name), path: r.path?.length ? r.path.join(" › ") : null }));
}

/** Ciudades que coinciden con lo escrito (`type=adgeolocation`, solo ciudades). Su `key` es lo que se usa para segmentar. */
export async function searchCities(token: string, q: string, limit = 10): Promise<CityResult[]> {
  const res = await graphGet<{ data?: { key?: string | number; name?: string; region?: string; country_code?: string }[] }>("search", {
    token,
    params: { type: "adgeolocation", location_types: JSON.stringify(["city"]), q, limit },
  });
  return (res.data ?? [])
    .filter((r) => r.key !== undefined && r.name && r.country_code)
    .map((r) => ({ key: String(r.key), name: String(r.name), region: r.region ?? null, countryCode: String(r.country_code) }));
}
