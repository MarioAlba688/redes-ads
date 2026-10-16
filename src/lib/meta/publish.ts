import "server-only";
import { env } from "@/lib/env";
import { MAX_IMAGES_PER_POST } from "@/lib/media-format";
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
/** `images` va en el orden en que se ve la publicacion (la primera es la portada). Vacio = solo texto. */
export type PublishInput = { text: string; linkUrl: string | null; images: PublishImage[] };
export type PublishResult = { externalId: string; url: string };
type Account = { externalId: string; token: string };

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

/**
 * Publica en una pagina de Facebook: con una imagen se sube la foto con el texto como pie; con varias se suben
 * todas SIN publicar y luego se crea una sola publicacion que las adjunta (asi salen juntas, en ese orden); sin
 * imagen es una publicacion de texto (con el enlace, si hay). Necesita pages_manage_posts y el token de la pagina.
 */
export async function publishToFacebookPage(page: Account, input: PublishInput): Promise<PublishResult> {
  if (input.images.length > MAX_IMAGES_PER_POST) {
    throw new PublishError(`Una publicación admite hasta ${MAX_IMAGES_PER_POST} imágenes.`, false);
  }
  if (input.images.length > 0) {
    // Ni una foto ni un grupo de fotos llevan campo de enlace: si hay uno, va al final del texto.
    const caption = input.linkUrl ? `${input.text}\n\n${input.linkUrl}` : input.text;
    const upload = (image: PublishImage, published: boolean, withCaption: boolean) =>
      graphPost<{ id: string; post_id?: string }>(`${page.externalId}/photos`, {
        token: page.token,
        params: { ...(withCaption ? { caption } : {}), published },
        file: { field: "source", bytes: image.bytes, filename: image.filename, mimeType: image.mimeType },
      });

    if (input.images.length === 1) {
      const res = await upload(input.images[0], true, true);
      const id = res.post_id ?? res.id;
      return { externalId: id, url: `https://www.facebook.com/${id}` };
    }

    // Una a una y en orden: el orden de las fotos adjuntas es el de la publicacion.
    const photoIds: string[] = [];
    for (const image of input.images) photoIds.push((await upload(image, false, false)).id);
    const attached: Record<string, string> = {};
    photoIds.forEach((id, i) => {
      attached[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    });
    const res = await graphPost<{ id: string }>(`${page.externalId}/feed`, {
      token: page.token,
      params: { message: caption, ...attached },
    });
    return { externalId: res.id, url: `https://www.facebook.com/${res.id}` };
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

/** Espera a que Instagram termine de procesar un contenedor. `what` es lo que se nombra en los mensajes. */
async function waitForContainer(ig: Account, id: string, pollMs: number, what: string): Promise<void> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const status = await graphGet<{ status_code?: string; status?: string }>(id, {
      token: ig.token,
      params: { fields: "status_code,status" },
    });
    if (status.status_code === "FINISHED" || status.status_code === undefined) return;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new PublishError(`Instagram rechazó ${what}${status.status ? `: ${status.status.slice(0, 160)}` : ""}.`, false);
    }
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new PublishError(`Instagram tarda demasiado en procesar ${what}. Se reintentará.`, true);
}

/**
 * Instagram publica en dos pasos: crea un "contenedor" con la imagen (Meta la descarga de nuestra URL publica),
 * espera a que lo procese y lo publica. Con varias imagenes es un carrusel: un contenedor por imagen (hijos, que
 * no se publican solos), uno padre que los reune en orden, y se publica el padre. Necesita instagram_content_publish
 * y una cuenta profesional.
 */
export async function publishToInstagram(
  ig: Account,
  input: PublishInput,
  opts: { pollMs?: number } = {},
): Promise<PublishResult> {
  if (input.images.length === 0) throw new PublishError("Instagram necesita una imagen y esta publicación no tiene.", false);
  if (input.images.length > MAX_IMAGES_PER_POST) {
    throw new PublishError(`Un carrusel de Instagram admite hasta ${MAX_IMAGES_PER_POST} imágenes.`, false);
  }
  const pollMs = opts.pollMs ?? 2000;

  let creationId: string;
  if (input.images.length === 1) {
    const container = await graphPost<{ id: string }>(`${ig.externalId}/media`, {
      token: ig.token,
      params: { image_url: input.images[0].publicUrl, caption: input.text },
    });
    await waitForContainer(ig, container.id, pollMs, "la imagen");
    creationId = container.id;
  } else {
    const children: string[] = [];
    for (const image of input.images) {
      const child = await graphPost<{ id: string }>(`${ig.externalId}/media`, {
        token: ig.token,
        params: { image_url: image.publicUrl, is_carousel_item: true },
      });
      children.push(child.id);
    }
    for (const id of children) await waitForContainer(ig, id, pollMs, "una de las imágenes");
    const parent = await graphPost<{ id: string }>(`${ig.externalId}/media`, {
      token: ig.token,
      params: { media_type: "CAROUSEL", children: children.join(","), caption: input.text },
    });
    await waitForContainer(ig, parent.id, pollMs, "el carrusel");
    creationId = parent.id;
  }

  const published = await graphPost<{ id: string }>(`${ig.externalId}/media_publish`, {
    token: ig.token,
    params: { creation_id: creationId },
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
