import "server-only";
import { env } from "@/lib/env";

/** Cookie con el `state` de la conexion en curso: protege contra conexiones forzadas (CSRF). */
export const TIKTOK_STATE_COOKIE = "redes_tiktok_state";

export type TikTokConfig = {
  appId: string;
  appSecret: string;
  /** https://business-api.tiktok.com (o el servidor de pruebas) */
  base: string;
  redirectUri: string;
};

/** Configuracion de TikTok Ads, o null si faltan TIKTOK_APP_ID / TIKTOK_APP_SECRET. */
export function tiktokConfig(): TikTokConfig | null {
  const e = env();
  if (!e.TIKTOK_APP_ID || !e.TIKTOK_APP_SECRET) return null;
  return {
    appId: e.TIKTOK_APP_ID,
    appSecret: e.TIKTOK_APP_SECRET,
    base: e.TIKTOK_API_BASE_URL?.replace(/\/$/, "") ?? "https://business-api.tiktok.com",
    redirectUri: `${e.APP_URL.replace(/\/$/, "")}/api/tiktok/callback`,
  };
}

export function requireTikTokConfig(): TikTokConfig {
  const cfg = tiktokConfig();
  if (!cfg) throw new Error("TikTok Ads no esta configurado: faltan TIKTOK_APP_ID y TIKTOK_APP_SECRET en .env.");
  return cfg;
}
