import "server-only";
import { env } from "@/lib/env";
import { MAX_IMAGES_PER_POST } from "@/lib/media-format";
import { requireMetaConfig } from "@/lib/meta/config";
import { MetaApiError, type GraphErrorBody } from "@/lib/meta/errors";
import { graphGet, graphPost, type GraphParams } from "@/lib/meta/graph";

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
  return { externalId: published.id, url: await instagramPermalink(ig, published.id) };
}

/** Enlace a lo ya publicado en Instagram. Es un extra: si no se puede leer, la publicacion ya salio igual. */
async function instagramPermalink(ig: Account, mediaId: string): Promise<string> {
  try {
    const info = await graphGet<{ permalink?: string }>(mediaId, { token: ig.token, params: { fields: "permalink" } });
    if (info.permalink) return info.permalink;
  } catch {
    // El enlace es un extra: la publicacion ya salio.
  }
  return "https://www.instagram.com/";
}

// ---------------------------------------------------------------------------
// Historias (una sola foto)
// ---------------------------------------------------------------------------

/**
 * Historia de una pagina de Facebook con una foto: la foto se sube SIN publicar (published=false) y luego se crea la
 * historia con ella (photo_stories). Por la API una historia sale sin texto, sin enlace y sin stickers. Meta no deja
 * usar en una historia una foto que ya salio en una publicacion: por eso siempre se sube de nuevo. Necesita
 * pages_manage_posts y el token de la pagina.
 */
export async function publishStoryToFacebookPage(page: Account, image: PublishImage): Promise<PublishResult> {
  const photo = await graphPost<{ id: string }>(`${page.externalId}/photos`, {
    token: page.token,
    params: { published: false },
    file: { field: "source", bytes: image.bytes, filename: image.filename, mimeType: image.mimeType },
  });
  const story = await graphPost<{ success?: boolean; post_id?: string }>(`${page.externalId}/photo_stories`, {
    token: page.token,
    params: { photo_id: photo.id },
  });
  // Sin confirmacion no se reintenta solo: si la historia si salio, repetirla la duplicaria.
  if (story.success !== true && !story.post_id) {
    throw new PublishError("Facebook no confirmó que la historia se publicara. Revisa la página antes de volver a intentarlo.", false);
  }
  const externalId = story.post_id ?? photo.id;
  return { externalId, url: await facebookStoryUrl(page, externalId) };
}

/** Enlace a la historia en Facebook, si Meta la lista; si no, la pagina. Solo se acepta una direccion de facebook.com. */
async function facebookStoryUrl(page: Account, postId: string): Promise<string> {
  try {
    const list = await graphGet<{ data?: { post_id?: string; url?: string }[] }>(`${page.externalId}/stories`, {
      token: page.token,
      params: { fields: "post_id,url", limit: 25 },
    });
    const url = list.data?.find((s) => s.post_id === postId)?.url;
    if (url && /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(url)) return url;
  } catch {
    // El enlace es un extra: la historia ya salio.
  }
  return `https://www.facebook.com/${page.externalId}`;
}

/**
 * Historia de Instagram con una foto: igual que una publicacion (contenedor con la URL publica de la imagen, espera a
 * que Meta la procese y se publica) pero con media_type=STORIES y sin pie de foto. Necesita instagram_content_publish
 * y una cuenta profesional.
 */
export async function publishStoryToInstagram(ig: Account, image: PublishImage, opts: { pollMs?: number } = {}): Promise<PublishResult> {
  const container = await graphPost<{ id: string }>(`${ig.externalId}/media`, {
    token: ig.token,
    params: { image_url: image.publicUrl, media_type: "STORIES" },
  });
  await waitForContainer(ig, container.id, opts.pollMs ?? 2000, "la foto de la historia");
  const published = await graphPost<{ id: string }>(`${ig.externalId}/media_publish`, {
    token: ig.token,
    params: { creation_id: container.id },
  });
  return { externalId: published.id, url: await instagramPermalink(ig, published.id) };
}

// ---------------------------------------------------------------------------
// Video: Reels e historias con video (se publican por fases: ver src/lib/publishing/video.ts)
// ---------------------------------------------------------------------------

export type PublishVideo = {
  size: number;
  mimeType: string;
  /** URL publica del video; Instagram lo descarga de ahi (vacia si el destino no la usa). */
  publicUrl: string;
  /** URL publica de la portada (JPG), si hay. */
  coverUrl: string | null;
  /** Lee el archivo entero: Facebook recibe los bytes directamente. */
  read: () => Promise<Uint8Array>;
};

/** Como va un video en la red: procesandose, listo (Instagram: puede publicarse; Facebook: ya esta publicado) o rechazado. */
export type VideoProgress = { state: "processing" } | { state: "ready" } | { state: "failed"; message: string };

/** La subida de un video grande puede tardar: margen de 8 minutos (menos que lo que tarda en darse por interrumpida). */
const UPLOAD_TIMEOUT_MS = 8 * 60_000;

/**
 * Un fallo sin respuesta clara de Meta en el paso que PUBLICA (red caida, error 5xx, "error desconocido"): no se sabe si
 * la publicacion salio. Repetirlo a ciegas podria duplicarla, asi que no se reintenta solo y se pide revisar.
 */
function ambiguous(e: unknown, what: string): never {
  if (e instanceof MetaApiError && (e.network || e.status >= 500 || e.code === 1 || e.code === 2)) {
    throw new PublishError(`No se pudo confirmar si ${what}. Revisa en la red social antes de volver a intentarlo, para no duplicarlo.`, false);
  }
  throw e;
}

/** Instagram, fase 1: crea el contenedor del Reel (o de la historia con video); Meta descarga el video de nuestra URL publica. */
export async function createInstagramVideoContainer(ig: Account, video: PublishVideo, opts: { story: boolean; caption: string }): Promise<string> {
  const params: GraphParams = opts.story
    ? { media_type: "STORIES", video_url: video.publicUrl }
    : { media_type: "REELS", video_url: video.publicUrl, caption: opts.caption, share_to_feed: true, ...(video.coverUrl ? { cover_url: video.coverUrl } : {}) };
  const container = await graphPost<{ id: string }>(`${ig.externalId}/media`, { token: ig.token, params });
  return container.id;
}

/** Instagram, fase 2: como va el procesamiento del contenedor. */
export async function checkInstagramContainer(ig: Account, containerId: string): Promise<VideoProgress> {
  const s = await graphGet<{ status_code?: string; status?: string }>(containerId, { token: ig.token, params: { fields: "status_code,status" } });
  switch (s.status_code) {
    case "ERROR":
      return { state: "failed", message: `Instagram rechazó el video${s.status ? `: ${s.status.slice(0, 160)}` : ""}.` };
    case "EXPIRED":
      return { state: "failed", message: "Instagram descartó el video porque no se publicó a tiempo (los contenedores duran 24 horas). Reintenta la publicación." };
    case "PUBLISHED":
      return { state: "failed", message: "Instagram indica que este video ya se publicó. Revisa en Instagram antes de volver a intentarlo, para no duplicarlo." };
    case "IN_PROGRESS":
      return { state: "processing" };
    default: // FINISHED (o sin dato, como en las fotos)
      return { state: "ready" };
  }
}

/** Instagram, fase 3 (irreversible): publica el contenedor ya procesado. Si la respuesta no es clara, no se repite solo. */
export async function publishInstagramContainer(ig: Account, containerId: string): Promise<PublishResult> {
  const published = await graphPost<{ id: string }>(`${ig.externalId}/media_publish`, { token: ig.token, params: { creation_id: containerId } }).catch((e) =>
    ambiguous(e, "Instagram publicó el video"),
  );
  return { externalId: published.id, url: await instagramPermalink(ig, published.id) };
}

/** Facebook, fase 1: abre la sesion de subida de un Reel (o de una historia con video). */
export async function startFacebookVideoUpload(page: Account, story: boolean): Promise<{ videoId: string; uploadUrl: string }> {
  const res = await graphPost<{ video_id?: string; upload_url?: string }>(`${page.externalId}/${story ? "video_stories" : "video_reels"}`, {
    token: page.token,
    params: { upload_phase: "start" },
  });
  if (!res.video_id || !res.upload_url) throw new PublishError("Facebook no devolvió los datos para subir el video. Se reintentará.", true);
  return { videoId: res.video_id, uploadUrl: res.upload_url };
}

/** El token solo se manda a servidores de Meta (o al de pruebas, que solo puede ser local). */
function assertUploadHost(uploadUrl: string): URL {
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new PublishError("Facebook devolvió una dirección de subida no válida. Se reintentará.", true);
  }
  const testHost = new URL(requireMetaConfig().graphBase).hostname;
  const ok = url.hostname === testHost || url.hostname === "rupload.facebook.com" || url.hostname.endsWith(".facebook.com");
  if (!ok || (url.protocol !== "https:" && url.hostname !== testHost)) {
    throw new PublishError("Facebook devolvió una dirección de subida que no es de Meta. Se canceló el envío del video.", false);
  }
  return url;
}

/** Facebook, fase 2: sube los bytes del video a la direccion de subida (rupload.facebook.com), con el token de la pagina. */
export async function uploadFacebookVideoBytes(uploadUrl: string, token: string, video: PublishVideo): Promise<void> {
  const url = assertUploadHost(uploadUrl);
  const bytes = await video.read();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(bytes.length), "content-type": "application/octet-stream" },
      body: bytes as unknown as BodyInit,
      cache: "no-store",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    // No propagamos el error original: podria incluir la URL.
    throw new MetaApiError({ message: "Sin respuesta de Meta.", network: true });
  }
  const json = (await res.json().catch(() => null)) as (GraphErrorBody & { success?: boolean; debug_info?: { message?: string } }) | null;
  if (!res.ok || json?.error) {
    if (json?.error) throw MetaApiError.fromResponse(res.status, json);
    throw new MetaApiError({ message: json?.debug_info?.message ?? `Meta respondio con HTTP ${res.status}.`, status: res.status });
  }
  if (json?.success !== true) throw new PublishError("Facebook no confirmó la subida del video. Se reintentará.", true);
}

/** Facebook, fase 3 (irreversible): da por terminada la subida y pide publicar. Si la respuesta no es clara, no se repite solo. */
export async function finishFacebookVideoUpload(page: Account, videoId: string, opts: { story: boolean; description: string }): Promise<{ postId: string | null }> {
  const params: GraphParams = opts.story
    ? { upload_phase: "finish", video_id: videoId }
    : { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: opts.description };
  const res = await graphPost<{ success?: boolean; post_id?: string }>(`${page.externalId}/${opts.story ? "video_stories" : "video_reels"}`, { token: page.token, params }).catch((e) =>
    ambiguous(e, "Facebook recibió el video"),
  );
  if (res.success !== true && !res.post_id) {
    throw new PublishError("Facebook no confirmó que recibió el video. Revisa en la página antes de volver a intentarlo, para no duplicarlo.", false);
  }
  return { postId: res.post_id ?? null };
}

type VideoPhase = { status?: string; error?: { message?: string } };
const phaseDone = (s?: string) => s === "complete" || s === "completed";

/** Facebook, fase 4: como va el procesamiento y la publicacion del video ya enviado. */
export async function checkFacebookVideo(page: Account, videoId: string): Promise<VideoProgress> {
  const res = await graphGet<{ status?: { video_status?: string; uploading_phase?: VideoPhase; processing_phase?: VideoPhase; publishing_phase?: VideoPhase & { publish_status?: string } } }>(videoId, {
    token: page.token,
    params: { fields: "status" },
  });
  const s = res.status ?? {};
  const phases = [s.publishing_phase, s.processing_phase, s.uploading_phase];
  if (s.video_status === "error" || phases.some((p) => p?.status === "error")) {
    const reason = phases.map((p) => p?.error?.message).find((m) => m);
    return { state: "failed", message: `Facebook rechazó el video${reason ? `: ${reason.slice(0, 160)}` : ""}.` };
  }
  if (s.video_status === "expired" || s.video_status === "upload_failed") {
    return { state: "failed", message: "Facebook no pudo recibir el video (la subida falló o caducó). Reintenta la publicación." };
  }
  if (s.publishing_phase?.publish_status === "published" || phaseDone(s.publishing_phase?.status)) return { state: "ready" };
  if (!s.publishing_phase && s.video_status === "ready") return { state: "ready" };
  return { state: "processing" };
}

/** Datos de la publicacion de video ya publicada en Facebook: su id y su enlace (el de la historia, si Meta la lista). */
export async function facebookVideoResult(page: Account, videoId: string, postId: string | null, story: boolean): Promise<PublishResult> {
  if (story) {
    const id = postId ?? videoId;
    return { externalId: id, url: await facebookStoryUrl(page, id) };
  }
  return { externalId: videoId, url: `https://www.facebook.com/reel/${videoId}` };
}

/**
 * URL por la que Meta descargara la imagen o el video para Instagram. Tiene que ser publica y con HTTPS: si APP_URL es
 * localhost o http, Instagram no podria bajarlo y fallaria sin explicar por que, asi que se avisa antes.
 * `what` es lo que se nombra en el mensaje.
 */
export function publicMediaUrl(storageKey: string, what = "la imagen"): string {
  const e = env();
  const explicit = e.MEDIA_PUBLIC_BASE_URL;
  const base = (explicit ?? e.APP_URL).replace(/\/$/, "");
  if (!explicit) {
    const host = new URL(base).hostname;
    if (!base.startsWith("https://") || host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
      throw new PublishError(
        `Instagram descarga ${what} desde internet y esta app no es accesible desde fuera (APP_URL es local o no usa HTTPS). Pon la app en un servidor con dominio y HTTPS y actualiza APP_URL.`,
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

/** Rechazos propios de Facebook para un video (codigos documentados en la guia de Reels): que arreglar en el video. */
const FACEBOOK_VIDEO_ERRORS: Record<number, string> = {
  1363040: "su proporción no está entre 9:16 (vertical) y 16:9 (horizontal).",
  1363127: "su resolución es muy baja (el mínimo es 540 × 960 píxeles).",
  1363128: "su duración no es válida (entre 3 y 90 segundos; las historias, hasta 60).",
  1363129: "sus fotogramas por segundo no son válidos (entre 24 y 60).",
};

/**
 * Convierte cualquier fallo al publicar en un mensaje en español y la decision de reintentar o no.
 * `video`: la publicacion lleva un video (algunos mensajes nombran el video en lugar de la imagen).
 */
export function classifyPublishError(e: unknown, ctx: { video?: boolean } = {}): ClassifiedError {
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
    const facebookVideo = e.code !== undefined ? FACEBOOK_VIDEO_ERRORS[e.code] : undefined;
    if (facebookVideo) return { message: `Facebook rechazó el video: ${facebookVideo}`, retryable: false, expired: false };
    if (ctx.video && e.subcode === 2207026) {
      return { message: "Instagram no acepta el formato de este video. Expórtalo de nuevo como MP4 con H.264 y AAC.", retryable: false, expired: false };
    }
    if (ctx.video && e.subcode === 2207003) {
      return { message: "Instagram tardó demasiado en descargar el video desde tu servidor. Se reintentará.", retryable: true, expired: false };
    }
    if (e.subcode === 2207052 || e.code === 9004 || /media.*(download|fetch)|could not be (fetched|downloaded)/i.test(e.message)) {
      return {
        message: ctx.video
          ? "Instagram no pudo descargar el video desde tu servidor. La app debe ser accesible desde internet por HTTPS y el video tiene que seguir disponible."
          : "Instagram no pudo descargar la imagen desde tu servidor. La app debe ser accesible desde internet por HTTPS.",
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
