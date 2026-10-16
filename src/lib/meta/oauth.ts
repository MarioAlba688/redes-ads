import "server-only";
import { requireMetaConfig } from "@/lib/meta/config";
import { graphGet } from "@/lib/meta/graph";

/** URL del cuadro de permisos de Facebook al que se manda a la persona. */
export function buildAuthorizeUrl(state: string): string {
  const cfg = requireMetaConfig();
  const url = new URL(`${cfg.dialogBase}/${cfg.version}/dialog/oauth`);
  url.searchParams.set("client_id", cfg.appId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (cfg.loginConfigId) {
    // Facebook Login for Business: los permisos los define la configuracion del panel de Meta.
    url.searchParams.set("config_id", cfg.loginConfigId);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", cfg.scopes.join(","));
    // Si en una conexion anterior rechazo algun permiso, lo vuelve a pedir.
    url.searchParams.set("auth_type", "rerequest");
  }
  return url.toString();
}

/** Cambia el codigo que devuelve Facebook por un token de corta duracion (~1-2 horas). */
export async function exchangeCode(code: string): Promise<string> {
  const cfg = requireMetaConfig();
  const res = await graphGet<{ access_token?: string }>("oauth/access_token", {
    params: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: cfg.redirectUri,
      code,
    },
  });
  if (!res.access_token) throw new Error("Meta no devolvio un token de acceso.");
  return res.access_token;
}

export type LongLivedToken = { accessToken: string; expiresAt: Date | null };

/** Cambia el token de corta duracion por uno de larga duracion (~60 dias). */
export async function toLongLivedToken(shortToken: string): Promise<LongLivedToken> {
  const cfg = requireMetaConfig();
  const res = await graphGet<{ access_token?: string; expires_in?: number }>("oauth/access_token", {
    params: {
      grant_type: "fb_exchange_token",
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: shortToken,
    },
  });
  if (!res.access_token) throw new Error("Meta no devolvio un token de larga duracion.");
  // Si Meta no informa la duracion (o manda algo raro), queda null en lugar de una fecha invalida.
  const seconds = Number(res.expires_in);
  return {
    accessToken: res.access_token,
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null,
  };
}
