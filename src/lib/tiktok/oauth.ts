import "server-only";
import { requireTikTokConfig } from "@/lib/tiktok/config";
import { tiktokRequest } from "@/lib/tiktok/client";

/** URL de la pantalla de autorizacion de TikTok For Business a la que se manda a la persona. */
export function buildAuthorizeUrl(state: string): string {
  const cfg = requireTikTokConfig();
  const url = new URL(`${cfg.base}/portal/auth`);
  url.searchParams.set("app_id", cfg.appId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export type TikTokToken = {
  accessToken: string;
  /** Anunciantes (cuentas publicitarias) que la persona autorizo para esta app. */
  advertiserIds: string[];
  /** Permisos concedidos (TikTok los identifica con numeros). */
  scopes: string[];
};

/**
 * Cambia el codigo de autorizacion que devuelve TikTok por un token. El token de la Marketing API no vence solo
 * (dura hasta que se revoca), por eso no hay renovacion.
 */
export async function exchangeAuthCode(authCode: string): Promise<TikTokToken> {
  const cfg = requireTikTokConfig();
  const data = await tiktokRequest<{ access_token?: unknown; advertiser_ids?: unknown; scope?: unknown }>("POST", "oauth2/access_token/", {
    body: { app_id: cfg.appId, secret: cfg.appSecret, auth_code: authCode },
  });
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("TikTok no devolvio un token de acceso.");
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  return { accessToken: data.access_token, advertiserIds: list(data.advertiser_ids), scopes: list(data.scope) };
}
