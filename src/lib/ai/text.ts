// Utilidades de texto puras (sin servidor) para las publicaciones: hashtags y palabras vetadas.

/** Minusculas y sin acentos, para comparar sin que "Promoción" y "promocion" sean distintas. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Lista de terminos a evitar: uno por linea o separados por comas/punto y coma. */
export function parseAvoidList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const terms = raw
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set(terms)];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Terminos vetados que aparecen en el texto. Compara sin acentos ni mayusculas y como palabra completa
 * (vetar "gratis" no marca "gratitud"). Devuelve los terminos tal como los escribio la persona.
 */
export function findForbidden(text: string, avoid: readonly string[]): string[] {
  const haystack = normalizeForMatch(text);
  return avoid.filter((term) => {
    const needle = normalizeForMatch(term).trim();
    if (!needle) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, "u").test(haystack);
  });
}

/** Deja solo letras y numeros de un hashtag (sin # ni espacios); null si no queda nada. */
function cleanHashtag(raw: string): string | null {
  const body = raw.replace(/^#+/, "").normalize("NFC").replace(/[^\p{L}\p{N}_]/gu, "");
  return body.length > 0 && body.length <= 60 ? body : null;
}

/** Hashtags limpios, con #, sin repetidos (ignorando mayusculas) y hasta `max`. */
export function normalizeHashtags(list: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const tag = cleanHashtag(raw);
    if (!tag) continue;
    const key = normalizeForMatch(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${tag}`);
    if (out.length >= max) break;
  }
  return out;
}

/** Los hashtags escritos en el perfil de marca (texto libre) como lista. */
export function parseBrandHashtags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return normalizeHashtags(raw.split(/[\s,;]+/), 30);
}

/** Texto final de una publicacion: el cuerpo y, aparte, los hashtags. */
export function assembleText(body: string, hashtags: readonly string[]): string {
  const clean = body.trim();
  return hashtags.length > 0 ? `${clean}\n\n${hashtags.join(" ")}` : clean;
}
