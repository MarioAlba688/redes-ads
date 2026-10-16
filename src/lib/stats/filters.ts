// Filtros de la pantalla Estadisticas. Logica pura: la usan la pantalla, el boton «Actualizar» y las pruebas.

export const STATS_RANGES = [7, 30, 90] as const;
export const STATS_KINDS = ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] as const;
export type StatsKind = (typeof STATS_KINDS)[number];

export type StatsFilters = { days: number; brandId: string | null; kind: StatsKind | null };

/** Valor de `red` en la direccion de la pagina para cada tipo de cuenta. */
export const NETWORK_PARAM: Record<StatsKind, string> = { FACEBOOK_PAGE: "facebook", INSTAGRAM_PROFILE: "instagram" };
export const NETWORK_LABELS: Record<StatsKind, string> = { FACEBOOK_PAGE: "Facebook", INSTAGRAM_PROFILE: "Instagram" };

const first = (v: string | string[] | undefined | null): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * Filtros a partir de lo que llega en la direccion (o en un formulario). Lo que no es valido se ignora en lugar de
 * fallar: un periodo raro vuelve a 30 dias, una marca que no existe se quita, una red desconocida es «todas».
 */
export function parseStatsFilters(
  raw: { dias?: string | string[] | null; marca?: string | string[] | null; red?: string | string[] | null },
  knownBrandIds: readonly string[],
): StatsFilters {
  const days = Number(first(raw.dias));
  const brand = first(raw.marca);
  const network = first(raw.red);
  return {
    days: (STATS_RANGES as readonly number[]).includes(days) ? days : 30,
    brandId: brand && knownBrandIds.includes(brand) ? brand : null,
    kind: STATS_KINDS.find((k) => NETWORK_PARAM[k] === network) ?? null,
  };
}

/** Direccion de la pantalla con esos filtros (solo lleva lo que no es el valor por defecto de «todas»). */
export function statsHref(f: StatsFilters, sort?: string | null): string {
  const q = new URLSearchParams({ dias: String(f.days) });
  if (f.kind) q.set("red", NETWORK_PARAM[f.kind]);
  if (f.brandId) q.set("marca", f.brandId);
  if (sort && sort !== "interacciones") q.set("orden", sort);
  return `/estadisticas?${q.toString()}`;
}
