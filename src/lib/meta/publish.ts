import "server-only";
import { env } from "@/lib/env";
import { MetaApiError } from "@/lib/meta/errors";
import { graphGet, graphPost } from "@/lib/meta/graph";

/** Fallo al publicar, ya clasificado: `retryable` dice si tiene sentido volver a intentarlo. */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** La conexion con Meta de la cuenta ya no sirve: hay que marcarla como vencida. */
    readonly expired = false,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export type PublishImage = { bytes: Uint8Array; mimeType: string; filename: string; publicUrl: string };
export type PublishInput = { text: string; linkUrl: string | null; image: PublishImage | null };
export type PublishResult = { externalId: string; url: string };
type Account = { externalId: string; token: string };

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

/**
 * Publica en una pagina de Facebook: con imagen se sube la foto con el texto como pie; sin imagen es una
 * publicacion de texto (con el enlace, si hay). Necesita el permiso pages_manage_posts y el token de la pagina.
 */
export async function publishToFacebookPage(page: Account, input: PublishInput): Promise<PublishResult> {
  if (input.image) {
    // Una foto no lleva campo de enlace: si hay uno, va al final del pie.
    const caption = input.linkUrl ? `${input.text}\n\n${input.linkUrl}` : input.text;
    const res = await graphPost<{ id: string; post_id?: string }>(`${page.externalId}/photos`, {
      token: page.token,
      params: { caption, published: true },
      file: { field: "source", bytes: input.image.bytes, filename: input.image.filename, mimeType: input.image.mimeType },
    });
    const id = res.post_id ?? res.id;
    return { externalId: id, url: `https://www.facebook.com/${id}` };
  }
  const res = await graphPost<{ id: string }>(`${page.externalId}/feed`, {
    token: page.token,
    params: { message: input.text, link: input.linkUrl ?? undefined },
  });
  return { externalId: res.id, url: `https://www.facebook.com/${res.id}` };
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

const POLL_ATTEMPTS = 15;

/**
 * Instagram publica en dos pasos: crea un "contenedor" con la imagen (Meta la descarga de nuestra URL publica),
 * espera a que lo procese y lo publica. Necesita instagram_content_publish y una cuenta profesional.
 */
export async function publishToInstagram(
  ig: Account,
  input: PublishInput,
  opts: { pollMs?: number } = {},
): Promise<PublishResult> {
  if (!input.image) throw new PublishError("Instagram necesita una imagen y esta publicación no tiene.", false);
  const pollMs = opts.pollMs ?? 2000;

  const container = await graphPost<{ id: string }>(`${ig.externalId}/media`, {
    token: ig.token,
    params: { image_url: input.image.publicUrl, caption: input.text },
  });

  let finished = false;
  for (let i = 0; i < POLL_ATTEMPTS && !finished; i++) {
    const status = await graphGet<{ status_code?: string; status?: string }>(container.id, {
      token: ig.token,
      params: { fields: "status_code,status" },
    });
    if (status.status_code === "FINISHED" || status.status_code === undefined) finished = true;
    else if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new PublishError(`Instagram rechazó la imagen${status.status ? `: ${status.status.slice(0, 160)}` : ""}.`, false);
    } else if (pollMs > 0) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  if (!finished) throw new PublishError("Instagram tarda demasiado en procesar la imagen. Se reintentará.", true);

  const published = await graphPost<{ id: string }>(`${ig.externalId}/media_publish`, {
    token: ig.token,
    params: { creation_id: container.id },
  });

  let url = "https://www.instagram.com/";
  try {
    const info = await graphGet<{ permalink?: string }>(published.id, { token: ig.token, params: { fields: "permalink" } });
    if (info.permalink) url = info.permalink;
  } catch {
    // El enlace es un extra: la publicacion ya salio.
  }
  return { externalId: published.id, url };
}

/**
 * URL por la que Meta descargara la imagen para Instagram. Tiene que ser publica y con HTTPS: si APP_URL es
 * localhost o http, Instagram no podria bajarla y fallaria sin explicar por que, asi que se avisa antes.
 */
export function publicMediaUrl(storageKey: string): string {
  const e = env();
  const explicit = e.MEDIA_PUBLIC_BASE_URL;
  const base = (explicit ?? e.APP_URL).replace(/\/$/, "");
  if (!explicit) {
    const host = new URL(base).hostname;
    if (!base.startsWith("https://") || host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
      throw new PublishError(
        "Instagram descarga la imagen desde internet y esta app no es accesible desde fuera (APP_URL es local o no usa HTTPS). Pon la app en un servidor con dominio y HTTPS y actualiza APP_URL.",
        false,
      );
    }
  }
  return `${base}/media/${storageKey}`;
}

// ---------------------------------------------------------------------------
// Clasificacion de errores
// ---------------------------------------------------------------------------

export type ClassifiedError = { message: string; retryable: boolean; expired: boolean };

/** Convierte cualquier fallo al publicar en un mensaje en español y la decision de reintentar o no. */
export function classifyPublishError(e: unknown): ClassifiedError {
  if (e instanceof PublishError) return { message: e.message, retryable: e.retryable, expired: e.expired };

  if (e instanceof MetaApiError) {
    if (e.network) {
      return { message: "No se pudo contactar a Meta (red o tiempo de espera). Se reintentará.", retryable: true, expired: false };
    }
    if (e.isAuthError) {
      return { message: "La conexión con Meta de esta cuenta venció o fue revocada. Reconecta Meta en Cuentas.", retryable: false, expired: true };
    }
    if (e.isRateLimit) {
      return { message: "Meta pidió esperar por exceso de consultas. Se reintentará.", retryable: true, expired: false };
    }
    if (e.code === 368 || /temporarily blocked|spam/i.test(e.message)) {
      return { message: "Meta bloqueó la publicación temporalmente por parecer spam. Espera un tiempo y reintenta.", retryable: false, expired: false };
    }
    if (e.isPermissionError) {
      // El texto de Meta (p. ej. «(#200) Requires pages_manage_posts permission...») dice cual falta; no lleva tokens.
      const detail = e.message ? ` Detalle de Meta: ${e.message.slice(0, 160)}` : "";
      return {
        message: `Meta rechazó la publicación por falta de permisos. La app necesita pages_manage_posts (Facebook) o instagram_content_publish (Instagram) y tu usuario debe tener control total de la cuenta.${detail}`,
        retryable: false,
        expired: false,
      };
    }
    if (e.subcode === 2207052 || e.code === 9004 || /media.*(download|fetch)|could not be (fetched|downloaded)/i.test(e.message)) {
      return {
        message: "Instagram no pudo descargar la imagen desde tu servidor. La app debe ser accesible desde internet por HTTPS.",
        retryable: true,
        expired: false,
      };
    }
    if (/duplicate/i.test(e.message)) {
      return { message: "Meta rechazó la publicación por ser un texto duplicado de otra reciente.", retryable: false, expired: false };
    }
    if (e.status >= 500 || e.code === 1 || e.code === 2) {
      return { message: "Meta tuvo un problema temporal. Se reintentará.", retryable: true, expired: false };
    }
    return { message: `Meta rechazó la publicación: ${e.message.slice(0, 200)}`, retryable: false, expired: false };
  }

  return { message: "Error interno al publicar. Revisa los registros del servidor.", retryable: false, expired: false };
}

/** Minutos de espera antes del reintento numero `attempt` (1 = tras el primer fallo). */
export const RETRY_BACKOFF_MINUTES = [2, 10, 30] as const;
export const MAX_PUBLISH_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1;

export function backoffMinutes(attempt: number): number {
  return RETRY_BACKOFF_MINUTES[Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MINUTES.length) - 1];
}
