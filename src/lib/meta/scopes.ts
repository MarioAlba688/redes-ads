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
 * Permisos para leer las estadisticas de lo publicado:
 * - `basic`: leer la publicacion (compartidos, y los "me gusta" y comentarios de Instagram). Sin el no hay nada que leer.
 * - `insights`: vistas, alcance y guardados.
 * - `content`: solo Facebook. Leer las reacciones y los comentarios de la publicacion es leer contenido de otras
 *   personas, y Meta lo pide aparte (error «(#10) This endpoint requires the 'pages_read_user_content' permission»).
 */
export const STATS_SCOPE = {
  FACEBOOK_PAGE: { basic: "pages_read_engagement", insights: "read_insights", content: "pages_read_user_content" },
  INSTAGRAM_PROFILE: { basic: "instagram_basic", insights: "instagram_manage_insights", content: null },
} as const;

export type MissingStatsScopes = { basic: string | null; insights: string | null; content: string | null };

/** Que permisos de estadisticas faltan en esa cuenta (null = lo tiene, o no se conoce la lista y decide Meta). */
export function missingStatsScopes(kind: string, scopes: string | null | undefined): MissingStatsScopes {
  const needed = STATS_SCOPE[kind as keyof typeof STATS_SCOPE];
  if (!needed || !scopes || !scopes.trim()) return { basic: null, insights: null, content: null };
  const granted = scopes.split(",").map((s) => s.trim());
  return {
    basic: granted.includes(needed.basic) ? null : needed.basic,
    insights: granted.includes(needed.insights) ? null : needed.insights,
    content: needed.content && !granted.includes(needed.content) ? needed.content : null,
  };
}

/** Aviso de lo que no se pudo leer por falta de un permiso, con los pasos para arreglarlo. */
export function missingStatsMessage(accountName: string, scope: string, lacks: "basic" | "insights" | "content"): string {
  const effect =
    lacks === "basic"
      ? "no se lee ninguna cifra"
      : lacks === "insights"
        ? "no se leen las vistas, el alcance ni los guardados"
        : "no se leen los comentarios, y las reacciones se calculan a partir de las estadísticas de la publicación (las interacciones no incluyen los comentarios)";
  return `La conexión con Meta de «${accountName}» no incluye el permiso ${scope}, así que ${effect}. Agrégalo en tu app de Meta, inclúyelo en META_SCOPES del archivo .env (o quita esa variable) y pulsa «Reconectar Meta» en Cuentas.`;
}

/** Mensaje para quien administra: que falta y como arreglarlo (la causa suele estar en la app de Meta o en META_SCOPES). */
export function missingScopeMessage(accountName: string, scope: string): string {
  return `La conexión con Meta de «${accountName}» no incluye el permiso ${scope}, necesario para publicar. Agrégalo en tu app de Meta (casos de uso de Páginas e Instagram), inclúyelo en META_SCOPES del archivo .env (o quita esa variable) y pulsa «Reconectar Meta» en Cuentas.`;
}
