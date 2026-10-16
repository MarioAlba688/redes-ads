import type { Targeting } from "@/lib/promotions/types";

// Segmentacion de los anuncios: paises, ciudades, edad, genero e intereses. Logica pura.

/** Paises que se ofrecen (America y Estados Unidos). Ninguno de la Union Europea: ver EU_COUNTRY_CODES. */
export const COUNTRIES = [
  { code: "CO", name: "Colombia" },
  { code: "MX", name: "México" },
  { code: "AR", name: "Argentina" },
  { code: "CL", name: "Chile" },
  { code: "PE", name: "Perú" },
  { code: "EC", name: "Ecuador" },
  { code: "BO", name: "Bolivia" },
  { code: "PY", name: "Paraguay" },
  { code: "UY", name: "Uruguay" },
  { code: "VE", name: "Venezuela" },
  { code: "BR", name: "Brasil" },
  { code: "PA", name: "Panamá" },
  { code: "CR", name: "Costa Rica" },
  { code: "GT", name: "Guatemala" },
  { code: "SV", name: "El Salvador" },
  { code: "HN", name: "Honduras" },
  { code: "NI", name: "Nicaragua" },
  { code: "DO", name: "República Dominicana" },
  { code: "PR", name: "Puerto Rico" },
  { code: "US", name: "Estados Unidos" },
  { code: "CA", name: "Canadá" },
] as const;

export const COUNTRY_NAMES: Record<string, string> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name]));

/**
 * Paises de la Union Europea. Meta exige para ellos quien paga y quien se beneficia del anuncio (reglamento DSA:
 * `dsa_payor` y `dsa_beneficiary`), datos que esta app no recoge, asi que no se ofrecen ni se aceptan en una ciudad.
 */
export const EU_COUNTRY_CODES: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

export const AGE_MIN = 18;
export const AGE_MAX = 65;
/** Radio permitido alrededor de una ciudad (Meta: de 17 a 80 km). */
export const CITY_RADIUS_MIN_KM = 17;
export const CITY_RADIUS_MAX_KM = 80;
export const CITY_RADIUS_DEFAULT_KM = 25;
export const MAX_INTERESTS = 10;
export const MAX_PLACES = 25;

export const DEFAULT_TARGETING: Targeting = { countries: ["CO"], cities: [], ageMin: 18, ageMax: 65, gender: "all", interests: [] };

/** Mensajes en español de lo que esta mal en la segmentacion (lista vacia = valida). */
export function validateTargeting(t: Targeting): string[] {
  const errors: string[] = [];
  const places = t.countries.length + t.cities.length;
  if (places === 0) errors.push("Elige al menos un país o una ciudad.");
  if (places > MAX_PLACES) errors.push(`Elige como máximo ${MAX_PLACES} países y ciudades.`);

  for (const code of t.countries) {
    if (!COUNTRY_NAMES[code]) errors.push(`El país «${code}» no está disponible.`);
  }
  if (new Set(t.countries).size !== t.countries.length) errors.push("Hay países repetidos.");

  for (const c of t.cities) {
    if (!c.key || !/^\d+$/.test(c.key)) errors.push(`La ciudad «${c.name || "sin nombre"}» no es válida: vuelve a elegirla de la búsqueda.`);
    if (EU_COUNTRY_CODES.includes(c.countryCode.toUpperCase())) {
      errors.push(`«${c.name}» está en la Unión Europea: Meta pide datos adicionales (DSA) que esta app no recoge. Crea ese anuncio directamente en Meta.`);
    }
    if (!Number.isFinite(c.radiusKm) || c.radiusKm < CITY_RADIUS_MIN_KM || c.radiusKm > CITY_RADIUS_MAX_KM) {
      errors.push(`El radio de «${c.name}» debe estar entre ${CITY_RADIUS_MIN_KM} y ${CITY_RADIUS_MAX_KM} km.`);
    }
  }
  if (new Set(t.cities.map((c) => c.key)).size !== t.cities.length) errors.push("Hay ciudades repetidas.");

  if (!Number.isInteger(t.ageMin) || !Number.isInteger(t.ageMax) || t.ageMin < AGE_MIN || t.ageMax > AGE_MAX || t.ageMin > t.ageMax) {
    errors.push(`La edad debe estar entre ${AGE_MIN} y ${AGE_MAX} años, y la mínima no puede superar a la máxima.`);
  }
  if (!["all", "men", "women"].includes(t.gender)) errors.push("El género elegido no es válido.");

  if (t.interests.length > MAX_INTERESTS) errors.push(`Elige como máximo ${MAX_INTERESTS} intereses.`);
  for (const i of t.interests) {
    if (!/^\d+$/.test(i.id)) errors.push(`El interés «${i.name || "sin nombre"}» no es válido: vuelve a elegirlo de la búsqueda.`);
  }
  if (new Set(t.interests.map((i) => i.id)).size !== t.interests.length) errors.push("Hay intereses repetidos.");
  return errors;
}

/**
 * Segmentacion en el formato de Meta. `targeting_automation.advantage_audience: 0` va siempre y explicito: desde la
 * v26 Meta lo exige cuando la segmentacion es restringida, y con 0 respeta lo que se eligio aqui (con 1 trataria la
 * edad, el genero y los intereses como simples sugerencias y mostraria el anuncio a otras personas).
 * Los intereses van en `flexible_spec` (el campo `interests` suelto ya no se usa).
 */
export function buildMetaTargeting(t: Targeting, opts: { instagramOnly?: boolean } = {}): Record<string, unknown> {
  const geo: Record<string, unknown> = {};
  if (t.countries.length) geo.countries = t.countries;
  if (t.cities.length) geo.cities = t.cities.map((c) => ({ key: c.key, radius: c.radiusKm, distance_unit: "kilometer" }));

  const spec: Record<string, unknown> = {
    geo_locations: geo,
    age_min: t.ageMin,
    age_max: t.ageMax,
    targeting_automation: { advantage_audience: 0 },
  };
  if (t.gender !== "all") spec.genders = [t.gender === "men" ? 1 : 2];
  if (t.interests.length) spec.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.id, name: i.name })) }];
  // Una publicacion de Instagram solo puede mostrarse en Instagram.
  if (opts.instagramOnly) spec.publisher_platforms = ["instagram"];
  return spec;
}

/** Resumen en una frase de a quien llega el anuncio (para listas y confirmaciones). */
export function describeTargeting(t: Targeting): string {
  const places = [...t.countries.map((c) => COUNTRY_NAMES[c] ?? c), ...t.cities.map((c) => `${c.name} (+${c.radiusKm} km)`)];
  const who = t.gender === "all" ? "todas las personas" : t.gender === "men" ? "hombres" : "mujeres";
  const interests = t.interests.length ? `, interesadas en ${t.interests.map((i) => i.name).join(", ")}` : "";
  return `${places.join(", ")} · ${t.ageMin}–${t.ageMax} años · ${who}${interests}`;
}
