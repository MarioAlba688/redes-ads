import "server-only";
import { env } from "@/lib/env";

/**
 * Permisos que se piden al conectar. Se piden todos de una vez (los de publicacion y
 * metricas organicas se usan en las fases siguientes) para no obligar a reconectar.
 * En modo desarrollo de la app de Meta funcionan para las personas con rol en la app;
 * para usarlos con cuentas ajenas Meta exige revision (App Review).
 */
export const META_SCOPES = [
  "ads_read", // leer cuentas publicitarias y su rendimiento
  // Sin este permiso, las paginas y cuentas publicitarias que pertenecen a un portafolio comercial
  // (Business Manager) y no al perfil de la persona no aparecen en /me/accounts ni en /me/adaccounts.
  "business_management",
  "pages_show_list", // listar las paginas de Facebook
  "pages_read_engagement", // leer datos de las paginas
  "pages_read_user_content", // leer comentarios y reacciones de las publicaciones (estadisticas)
  "pages_manage_posts", // publicar en paginas de Facebook (Fase 3)
  "read_insights", // metricas de las paginas
  "instagram_basic", // datos basicos de la cuenta de Instagram vinculada
  "instagram_content_publish", // publicar en Instagram (Fase 3)
  "instagram_manage_insights", // metricas de Instagram
] as const;

/** Cookie con el `state` de la conexion en curso: protege contra conexiones forzadas (CSRF). */
export const META_STATE_COOKIE = "redes_meta_state";

/** Sin este permiso no se puede leer el rendimiento de los anuncios. */
export const META_REQUIRED_SCOPE = "ads_read";

export type MetaConfig = {
  appId: string;
  appSecret: string;
  version: string;
  /** Permisos que se piden al conectar (los de META_SCOPES en .env, o todos por defecto). */
  scopes: string[];
  /** ID de configuracion de "Facebook Login for Business"; null si se usa el inicio de sesion clasico. */
  loginConfigId: string | null;
  /** https://graph.facebook.com (o el servidor de pruebas) */
  graphBase: string;
  /** https://www.facebook.com (o el servidor de pruebas) */
  dialogBase: string;
  redirectUri: string;
};

/** Configuracion de Meta, o null si faltan META_APP_ID / META_APP_SECRET. */
export function metaConfig(): MetaConfig | null {
  const e = env();
  if (!e.META_APP_ID || !e.META_APP_SECRET) return null;
  const override = e.META_API_BASE_URL?.replace(/\/$/, "");
  return {
    appId: e.META_APP_ID,
    appSecret: e.META_APP_SECRET,
    version: e.META_GRAPH_VERSION,
    scopes: e.META_SCOPES
      ? e.META_SCOPES.split(",").map((s) => s.trim()).filter(Boolean)
      : [...META_SCOPES],
    loginConfigId: e.META_LOGIN_CONFIG_ID ?? null,
    graphBase: override ?? "https://graph.facebook.com",
    dialogBase: override ?? "https://www.facebook.com",
    redirectUri: `${e.APP_URL.replace(/\/$/, "")}/api/meta/callback`,
  };
}

export function requireMetaConfig(): MetaConfig {
  const cfg = metaConfig();
  if (!cfg) {
    throw new Error("Meta no esta configurado: faltan META_APP_ID y META_APP_SECRET en .env.");
  }
  return cfg;
}
