import "server-only";

export type HttpResult = { net: true } | { net: false; status: number; body: unknown };

const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

/** Espera sugerida por el servidor (en ms), con tope; si no dice nada, 1 s, 2 s... */
function waitMs(headers: Headers, attempt: number): number {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0 && headers.get("retry-after-ms") !== null) return Math.min(ms, 5000);
  const s = Number(headers.get("retry-after"));
  if (Number.isFinite(s) && s >= 0 && headers.get("retry-after") !== null) return Math.min(s * 1000, 5000);
  return Math.min(1000 * 2 ** attempt, 5000);
}

/**
 * Llamada JSON a la API de un proveedor. Reintenta (hasta 2 veces) ante caidas de red, limites de uso y errores del
 * servidor, salvo que `noRetry` diga que no sirve de nada (por ejemplo, sin saldo). Nunca lanza y nunca registra la URL
 * ni las cabeceras (llevan la clave).
 */
export async function requestJson(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown },
  opts: { noRetry?: (status: number, body: unknown) => boolean } = {},
): Promise<HttpResult> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: { ...init.headers, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      if (attempt >= MAX_RETRIES) return { net: true };
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 5000)));
      continue;
    }

    const body: unknown = await res.json().catch(() => null);
    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES && !opts.noRetry?.(res.status, body)) {
      await new Promise((r) => setTimeout(r, waitMs(res.headers, attempt)));
      continue;
    }
    return { net: false, status: res.status, body };
  }
}

/** Lee `a.b.c` de un objeto desconocido (las respuestas de cada API se tratan como datos no confiables). */
export function pick(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export const asString = (v: unknown): string => (typeof v === "string" ? v : "");
export const asNumber = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
