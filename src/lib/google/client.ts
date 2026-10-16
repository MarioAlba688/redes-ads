import "server-only";
import { requireGoogleConfig } from "@/lib/google/config";
import { GoogleApiError } from "@/lib/google/errors";

const TIMEOUT_MS = 60_000;

/** Los IDs de cliente de Google Ads son numeros sin guiones; se validan porque van dentro de la URL. */
export const CUSTOMER_ID_RE = /^\d{1,12}$/;

export type AdsAuth = {
  accessToken: string;
  /** Cuenta administradora (MCC) a traves de la cual se consulta una cuenta cliente; null si el acceso es directo. */
  loginCustomerId?: string | null;
};

/**
 * Llamada a la API de Google Ads (REST). Nunca registra la URL ni las cabeceras (llevan el token); los errores se
 * convierten en GoogleApiError con un mensaje seguro para mostrar.
 */
export async function adsRequest<T>(path: string, auth: AdsAuth, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const cfg = requireGoogleConfig();
  const headers: Record<string, string> = { authorization: `Bearer ${auth.accessToken}` };
  // Google ya no lo exige (desde 2026-09-09) pero acepta que se envie.
  if (cfg.developerToken) headers["developer-token"] = cfg.developerToken;
  if (auth.loginCustomerId) {
    if (!CUSTOMER_ID_RE.test(auth.loginCustomerId)) throw new Error("ID de cuenta administradora no valido.");
    headers["login-customer-id"] = auth.loginCustomerId;
  }
  if (init.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${cfg.adsBase}/${cfg.apiVersion}/${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // No se propaga el error original: su mensaje podria incluir la URL.
    throw new GoogleApiError({ message: "Sin respuesta de Google.", network: true });
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw GoogleApiError.fromAdsResponse(res.status, body);
  if (body === null) throw new GoogleApiError({ message: "Respuesta no valida de Google.", status: res.status });
  return body as T;
}

/** Consulta GAQL y devuelve todas las filas (la API las manda en un arreglo de lotes: se aplanan). */
export async function searchStream<T = Record<string, unknown>>(customerId: string, query: string, auth: AdsAuth): Promise<T[]> {
  if (!CUSTOMER_ID_RE.test(customerId)) throw new Error("ID de cliente de Google Ads no valido.");
  const body = await adsRequest<unknown>(`customers/${customerId}/googleAds:searchStream`, auth, { body: { query } });
  const batches = Array.isArray(body) ? body : [body];
  return batches.flatMap((b) => ((b as { results?: T[] } | null)?.results ?? []));
}
