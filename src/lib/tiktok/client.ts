import "server-only";
import { requireTikTokConfig } from "@/lib/tiktok/config";
import { TikTokApiError } from "@/lib/tiktok/errors";

const TIMEOUT_MS = 60_000;

type Envelope<T> = { code?: number; message?: string; data?: T };

/**
 * Llamada a la Marketing API de TikTok (v1.3). El token va en la cabecera `Access-Token`; nunca se registra la URL ni
 * las cabeceras. Los errores se convierten en TikTokApiError con un mensaje seguro para mostrar.
 */
export async function tiktokRequest<T>(
  method: "GET" | "POST",
  path: string,
  opts: { accessToken?: string; query?: Record<string, string | number | string[]>; body?: unknown } = {},
): Promise<T> {
  const cfg = requireTikTokConfig();
  const url = new URL(`${cfg.base}/open_api/v1.3/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    // Las listas viajan como texto JSON: advertiser_ids=["1","2"].
    url.searchParams.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  const headers: Record<string, string> = {};
  if (opts.accessToken) headers["Access-Token"] = opts.accessToken;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // No se propaga el error original: su mensaje podria incluir la URL.
    throw new TikTokApiError({ message: "Sin respuesta de TikTok.", network: true });
  }

  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!body || typeof body !== "object") throw new TikTokApiError({ message: "Respuesta no valida de TikTok.", status: res.status });
  // HTTP 200 no basta: el resultado esta en `code`.
  if (!res.ok || (body.code !== undefined && body.code !== 0)) {
    throw new TikTokApiError({ message: body.message ?? `TikTok respondio con HTTP ${res.status}.`, status: res.status, code: body.code });
  }
  if (body.data === undefined) throw new TikTokApiError({ message: "Respuesta sin datos de TikTok.", status: res.status });
  return body.data;
}
