// Estadisticas de las publicaciones: cifras, calculos y calendario de lecturas. Logica pura (sin servidor ni base de datos):
// la usan el proceso en segundo plano, la pantalla Estadisticas y las pruebas.

/** Cifras de una publicacion en un destino. `null` = la red no entrego esa cifra (no es lo mismo que 0). */
export type PostMetrics = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
};

export const EMPTY_METRICS: PostMetrics = { views: null, reach: null, likes: null, comments: null, shares: null, saves: null };

/** Las columnas son INT de MySQL (32 bits con signo). */
const MAX_COUNT = 2_147_483_647;

/** Convierte lo que devuelve Meta (numero o texto) en una cifra valida, o null si no lo es. */
export function clampCount(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), MAX_COUNT);
}

/** Cada cifra nueva manda; si Meta no entrego una esta vez, se conserva la anterior. */
export function mergeMetrics(fresh: PostMetrics, previous: PostMetrics | null): PostMetrics {
  const old = previous ?? EMPTY_METRICS;
  return {
    views: fresh.views ?? old.views,
    reach: fresh.reach ?? old.reach,
    likes: fresh.likes ?? old.likes,
    comments: fresh.comments ?? old.comments,
    shares: fresh.shares ?? old.shares,
    saves: fresh.saves ?? old.saves,
  };
}

/** Reacciones + comentarios + compartidos + guardados (lo que haya). null si no se conoce ninguna. */
export function interactions(m: PostMetrics): number | null {
  const parts = [m.likes, m.comments, m.shares, m.saves].filter((v): v is number => v !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** Interacciones por persona alcanzada (0,05 = 5 %). null si falta el alcance o es 0. */
export function engagementRate(m: PostMetrics): number | null {
  const total = interactions(m);
  if (total === null || m.reach === null || m.reach <= 0) return null;
  return total / m.reach;
}

// ---------------------------------------------------------------------------
// Cuando volver a leer
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Pasado este tiempo las cifras ya casi no se mueven: se deja de leerlas solas (a mano se puede). */
export const STATS_MAX_AGE_DAYS = 90;

/**
 * Cuando volver a leer una publicacion que se acaba de leer bien: las cifras se mueven rapido los primeros dias
 * y casi nada despues, asi que se lee cada 3 h el primer par de dias, cada 12 h hasta las dos semanas y a diario hasta
 * los 90 dias. null = ya no se lee sola.
 */
export function nextFetchAfter(publishedAt: Date, now: Date): Date | null {
  const age = now.getTime() - publishedAt.getTime();
  if (age >= STATS_MAX_AGE_DAYS * DAY) return null;
  const every = age < 2 * DAY ? 3 * HOUR : age < 14 * DAY ? 12 * HOUR : DAY;
  return new Date(now.getTime() + every);
}

export type FailureKind = "expired" | "rate" | "network" | "permission" | "gone" | "other";

const RETRY_MINUTES: Record<FailureKind, number> = {
  network: 30, // caida o problema pasajero de Meta
  rate: 120, // limite de uso: dejar respirar
  // Con la conexion vencida la cuenta ni se selecciona; esto solo hace que, al reconectar, se retome en una hora.
  expired: 60,
  gone: 24 * 60,
  permission: 12 * 60,
  other: 12 * 60,
};

/** Cuando reintentar tras un fallo: lo pasajero pronto; lo que pide una accion de una persona, de vez en cuando. */
export function retryAfterFailure(kind: FailureKind, now: Date): Date {
  return new Date(now.getTime() + RETRY_MINUTES[kind] * 60_000);
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

export type Summary = {
  /** Publicaciones con cifras leidas. */
  measured: number;
  /** Publicaciones que aun no se leyeron. */
  pending: number;
  views: number | null;
  reach: number | null;
  /** Alcance medio por publicacion (el alcance de varias no se puede sumar: una persona puede verlas todas). */
  avgReach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  interactions: number | null;
  /** Interacciones por persona alcanzada, ponderada: suma de interacciones / suma de alcances. */
  rate: number | null;
};

function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** Totales de un grupo de publicaciones. Las cifras que ninguna trae quedan en null (no en 0). */
export function summarize(rows: { metrics: PostMetrics | null }[]): Summary {
  const measuredRows = rows.flatMap((r) => (r.metrics ? [r.metrics] : []));
  const reaches = measuredRows.map((m) => m.reach);
  const reach = sumKnown(reaches);
  const knownReaches = reaches.filter((v): v is number => v !== null);

  // La tasa solo cuenta publicaciones con alcance y con alguna interaccion conocida, en numerador y denominador.
  const comparable = measuredRows.filter((m) => m.reach !== null && m.reach > 0 && interactions(m) !== null);
  const comparableReach = comparable.reduce((a, m) => a + (m.reach as number), 0);
  const comparableInteractions = comparable.reduce((a, m) => a + (interactions(m) as number), 0);

  return {
    measured: measuredRows.length,
    pending: rows.length - measuredRows.length,
    views: sumKnown(measuredRows.map((m) => m.views)),
    reach,
    avgReach: reach !== null && knownReaches.length ? reach / knownReaches.length : null,
    likes: sumKnown(measuredRows.map((m) => m.likes)),
    comments: sumKnown(measuredRows.map((m) => m.comments)),
    shares: sumKnown(measuredRows.map((m) => m.shares)),
    saves: sumKnown(measuredRows.map((m) => m.saves)),
    interactions: sumKnown(measuredRows.map((m) => interactions(m))),
    rate: comparableReach > 0 ? comparableInteractions / comparableReach : null,
  };
}

export const SORT_KEYS = ["interacciones", "alcance", "vistas", "recientes"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && (SORT_KEYS as readonly string[]).includes(value);
}

export const SORT_LABELS: Record<SortKey, string> = {
  interacciones: "Más interacciones",
  alcance: "Mayor alcance",
  vistas: "Más vistas",
  recientes: "Más recientes",
};

/** Ordena de mayor a menor segun el criterio; lo que no tiene cifra va al final. No modifica el arreglo recibido. */
export function sortRows<T extends { metrics: PostMetrics | null; publishedAt: Date }>(rows: T[], key: SortKey): T[] {
  const value = (r: T): number | null => {
    if (key === "recientes") return r.publishedAt.getTime();
    if (!r.metrics) return null;
    return key === "interacciones" ? interactions(r.metrics) : key === "alcance" ? r.metrics.reach : r.metrics.views;
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return b.publishedAt.getTime() - a.publishedAt.getTime();
    if (va === null) return 1;
    if (vb === null) return -1;
    return vb - va || b.publishedAt.getTime() - a.publishedAt.getTime();
  });
}
