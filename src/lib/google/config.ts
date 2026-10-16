import "server-only";
import { env } from "@/lib/env";

/** Permiso de Google para leer y administrar cuentas de Google Ads. Aqui solo se usa para leer el rendimiento. */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

/** Cookie con el `state` de la conexion en curso: protege contra conexiones forzadas (CSRF). */
export const GOOGLE_STATE_COOKIE = "redes_google_state";

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  /** Version de la API de Google Ads, por ejemplo «v25». */
  apiVersion: string;
  /** Opcional: desde septiembre de 2026 Google lo ignora, pero se sigue enviando si esta puesto. */
  developerToken: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  adsBase: string;
  redirectUri: string;
};

/** Configuracion de Google Ads, o null si faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. */
export function googleConfig(): GoogleConfig | null {
  const e = env();
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) return null;
  const oauth = e.GOOGLE_OAUTH_BASE_URL?.replace(/\/$/, "");
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    apiVersion: e.GOOGLE_ADS_API_VERSION,
    developerToken: e.GOOGLE_ADS_DEVELOPER_TOKEN ?? null,
    authorizeUrl: oauth ? `${oauth}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: oauth ? `${oauth}/token` : "https://oauth2.googleapis.com/token",
    adsBase: e.GOOGLE_ADS_API_BASE_URL?.replace(/\/$/, "") ?? "https://googleads.googleapis.com",
    redirectUri: `${e.APP_URL.replace(/\/$/, "")}/api/google/callback`,
  };
}

export function requireGoogleConfig(): GoogleConfig {
  const cfg = googleConfig();
  if (!cfg) throw new Error("Google Ads no esta configurado: faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en .env.");
  return cfg;
}
