/**
 * Interpreta la cabecera `Range` de una peticion (solo `bytes=` con UN tramo, que es lo que mandan los navegadores al
 * reproducir un video y lo que usa Meta). Devuelve:
 *  - null: no hay tramo que atender (sin cabecera, varios tramos o un formato raro): se sirve el archivo entero;
 *  - "invalid": el tramo no cabe en el archivo (se responde 416);
 *  - { start, end }: bytes a servir, ambos inclusive.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, from, to] = m;
  if (from === "" && to === "") return "invalid";
  if (from === "") {
    // "-N": los ultimos N bytes
    const n = Number(to);
    if (!Number.isSafeInteger(n) || n === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return "invalid";
  return { start, end };
}
