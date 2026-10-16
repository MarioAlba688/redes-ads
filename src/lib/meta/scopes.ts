// Permisos de Meta necesarios para publicar. Logica pura (sin servidor): la usan las comprobaciones previas, el worker y la pantalla Cuentas.

/** Permiso que Meta exige para publicar en cada tipo de cuenta. */
export const PUBLISH_SCOPE = {
  FACEBOOK_PAGE: "pages_manage_posts",
  INSTAGRAM_PROFILE: "instagram_content_publish",
} as const;

/**
 * Permiso que falta para publicar en esa cuenta, o null si lo tiene. Si no se conoce la lista de permisos concedidos
 * (conexiones guardadas sin ella) tampoco se bloquea nada: en ese caso decide Meta al publicar.
 */
export function missingPublishScope(kind: string, scopes: string | null | undefined): string | null {
  const needed = PUBLISH_SCOPE[kind as keyof typeof PUBLISH_SCOPE];
  if (!needed || !scopes || !scopes.trim()) return null;
  const granted = scopes.split(",").map((s) => s.trim());
  return granted.includes(needed) ? null : needed;
}

/**
 * Permisos para leer las estadisticas de lo publicado. `basic` da reacciones, comentarios y compartidos (y los
 * "me gusta" de Instagram); `insights` da vistas, alcance y guardados. Sin `basic` no hay nada que leer.
 */
export const STATS_SCOPE = {
  FACEBOOK_PAGE: { basic: "pages_read_engagement", insights: "read_insights" },
  INSTAGRAM_PROFILE: { basic: "instagram_basic", insights: "instagram_manage_insights" },
} as const;

/** Que permisos de estadisticas faltan en esa cuenta (null = lo tiene, o no se conoce la lista y decide Meta). */
export function missingStatsScopes(kind: string, scopes: string | null | undefined): { basic: string | null; insights: string | null } {
  const needed = STATS_SCOPE[kind as keyof typeof STATS_SCOPE];
  if (!needed || !scopes || !scopes.trim()) return { basic: null, insights: null };
  const granted = scopes.split(",").map((s) => s.trim());
  return {
    basic: granted.includes(needed.basic) ? null : needed.basic,
    insights: granted.includes(needed.insights) ? null : needed.insights,
  };
}

/** Aviso de lo que no se pudo leer por falta de un permiso, con los pasos para arreglarlo. */
export function missingStatsMessage(accountName: string, scope: string, lacks: "basic" | "insights"): string {
  const effect = lacks === "basic" ? "no se lee ninguna cifra" : "no se leen las vistas, el alcance ni los guardados";
  return `La conexión con Meta de «${accountName}» no incluye el permiso ${scope}, así que ${effect}. Agrégalo en tu app de Meta, inclúyelo en META_SCOPES del archivo .env (o quita esa variable) y pulsa «Reconectar Meta» en Cuentas.`;
}

/** Mensaje para quien administra: que falta y como arreglarlo (la causa suele estar en la app de Meta o en META_SCOPES). */
export function missingScopeMessage(accountName: string, scope: string): string {
  return `La conexión con Meta de «${accountName}» no incluye el permiso ${scope}, necesario para publicar. Agrégalo en tu app de Meta (casos de uso de Páginas e Instagram), inclúyelo en META_SCOPES del archivo .env (o quita esa variable) y pulsa «Reconectar Meta» en Cuentas.`;
}
