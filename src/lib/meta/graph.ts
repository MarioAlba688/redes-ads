import "server-only";
import { createHmac } from "node:crypto";
import { requireMetaConfig } from "@/lib/meta/config";
import { MetaApiError, type GraphErrorBody } from "@/lib/meta/errors";

export type GraphParams = Record<string, string | number | boolean | undefined>;

const TIMEOUT_MS = 20_000;
const MAX_PAGES = 100;

/**
 * Prueba de que la llamada sale de nuestro servidor y no de alguien que robo el token:
 * HMAC-SHA256 del token con el secreto de la app. Meta puede exigirla en la configuracion de la app.
 */
export function appSecretProof(token: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

/**
 * GET a la Graph API. Nunca registra la URL (lleva el token); los errores se
 * convierten en MetaApiError con un mensaje seguro para mostrar.
 */
export async function graphGet<T>(
  path: string,
  opts: { token?: string; params?: GraphParams } = {},
): Promise<T> {
  const cfg = requireMetaConfig();
  const url = new URL(`${cfg.graphBase}/${cfg.version}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (opts.token) {
    url.searchParams.set("access_token", opts.token);
    url.searchParams.set("appsecret_proof", appSecretProof(opts.token, cfg.appSecret));
  }

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // No propagamos el error original: su mensaje podria incluir la URL con el token.
    throw new MetaApiError({ message: "Sin respuesta de Meta.", network: true });
  }

  const body = (await res.json().catch(() => null)) as (T & GraphErrorBody) | null;
  if (!res.ok || (body && typeof body === "object" && body.error)) {
    throw MetaApiError.fromResponse(res.status, body);
  }
  if (body === null) {
    throw new MetaApiError({ message: "Respuesta no valida de Meta.", status: res.status });
  }
  return body;
}

/**
 * POST a la Graph API (publicar). El token y la prueba van en el cuerpo y no en la URL. Con `file` el cuerpo
 * es multipart (subir una foto a una pagina); si no, un formulario normal.
 */
export async function graphPost<T>(
  path: string,
  opts: {
    token: string;
    params?: GraphParams;
    file?: { field: string; bytes: Uint8Array; filename: string; mimeType: string };
  },
): Promise<T> {
  const cfg = requireMetaConfig();
  const url = new URL(`${cfg.graphBase}/${cfg.version}/${path.replace(/^\/+/, "")}`);
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value !== undefined) fields[key] = String(value);
  }
  fields.access_token = opts.token;
  fields.appsecret_proof = appSecretProof(opts.token, cfg.appSecret);

  let body: URLSearchParams | FormData;
  if (opts.file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set(opts.file.field, new Blob([new Uint8Array(opts.file.bytes)], { type: opts.file.mimeType }), opts.file.filename);
    body = form;
  } else {
    body = new URLSearchParams(fields);
  }

  let res: Response;
  try {
    // Publicar puede tardar mas que consultar (sube una imagen): margen de 60 s.
    res = await fetch(url, { method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new MetaApiError({ message: "Sin respuesta de Meta.", network: true });
  }
  const json = (await res.json().catch(() => null)) as (T & GraphErrorBody) | null;
  if (!res.ok || (json && typeof json === "object" && json.error)) throw MetaApiError.fromResponse(res.status, json);
  if (json === null) throw new MetaApiError({ message: "Respuesta no valida de Meta.", status: res.status });
  return json;
}

type Paged<T> = {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
};

/**
 * Recorre todas las paginas de una lista. Usa el cursor `after` y no la URL
 * `paging.next` (que trae el token y apunta a un host que no controlamos).
 */
export async function graphGetAll<T>(
  path: string,
  opts: { token?: string; params?: GraphParams } = {},
): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await graphGet<Paged<T>>(path, {
      token: opts.token,
      params: { limit: 100, ...opts.params, after },
    });
    items.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) return items;
  }
  throw new MetaApiError({ message: `La lista de ${path} tiene demasiadas paginas.` });
}
