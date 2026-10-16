import "server-only";
import { GOOGLE_ADS_SCOPE, requireGoogleConfig } from "@/lib/google/config";
import { GoogleApiError } from "@/lib/google/errors";

/** URL del cuadro de permisos de Google al que se manda a la persona. */
export function buildAuthorizeUrl(state: string): string {
  const cfg = requireGoogleConfig();
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  // «openid email» solo sirve para mostrar con que cuenta de Google se conecto; los datos de anuncios van con «adwords».
  url.searchParams.set("scope", `${GOOGLE_ADS_SCOPE} openid email`);
  // offline + consent: sin esto Google no devuelve el token de renovacion (el unico que dura) en conexiones repetidas.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export type GoogleTokens = {
  accessToken: string;
  /** Dura hasta que se revoque; null si Google no lo devolvio. */
  refreshToken: string | null;
  /** Cuando vence el token de acceso (dura ~1 hora). */
  expiresAt: Date;
  scopes: string[];
  /** Correo de la cuenta de Google que dio el permiso (solo informativo). */
  email: string | null;
};

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const cfg = requireGoogleConfig();
  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // No se propaga el error original: podria incluir datos de la peticion.
    throw new GoogleApiError({ message: "Sin respuesta de Google.", network: true });
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw GoogleApiError.fromOAuthResponse(res.status, body);
  if (!body || typeof body !== "object") throw new GoogleApiError({ message: "Respuesta no valida de Google.", status: res.status });
  return body as Record<string, unknown>;
}

/** Correo del id_token. Se recibe directo del servidor de Google por HTTPS, asi que no hace falta verificar su firma. */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email.slice(0, 191) : null;
  } catch {
    return null;
  }
}

const expiryFrom = (expiresIn: unknown): Date => {
  const seconds = Number(expiresIn);
  return new Date(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
};

/** Cambia el codigo que devuelve Google por los tokens. */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const cfg = requireGoogleConfig();
  const b = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });
  if (typeof b.access_token !== "string" || !b.access_token) throw new Error("Google no devolvio un token de acceso.");
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    expiresAt: expiryFrom(b.expires_in),
    scopes: typeof b.scope === "string" ? b.scope.split(/\s+/).filter(Boolean) : [],
    email: emailFromIdToken(b.id_token),
  };
}

/** Pide un token de acceso nuevo con el token de renovacion. */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const cfg = requireGoogleConfig();
  const b = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (typeof b.access_token !== "string" || !b.access_token) throw new Error("Google no devolvio un token de acceso.");
  return { accessToken: b.access_token, expiresAt: expiryFrom(b.expires_in) };
}
