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

/** Mensaje para quien administra: que falta y como arreglarlo (la causa suele estar en la app de Meta o en META_SCOPES). */
export function missingScopeMessage(accountName: string, scope: string): string {
  return `La conexión con Meta de «${accountName}» no incluye el permiso ${scope}, necesario para publicar. Agrégalo en tu app de Meta (casos de uso de Páginas e Instagram), inclúyelo en META_SCOPES del archivo .env (o quita esa variable) y pulsa «Reconectar Meta» en Cuentas.`;
}
