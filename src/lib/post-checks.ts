import { instagramImageError, instagramStoryImageError, MAX_IMAGES_PER_POST, MAX_IMAGES_PER_STORY } from "@/lib/media-format";
import { missingPublishScope, missingScopeMessage } from "@/lib/meta/scopes";
import { lengthError } from "@/lib/post-validation";
import type { PostFormatName } from "@/lib/posts";
import { MAX_VIDEOS_PER_POST, parseVideoDetails, videoProblems } from "@/lib/video-format";

// Comprobaciones previas: todo lo que se sabe de antemano que haria fallar la publicacion se avisa antes de
// mandarla a revision, aprobarla o programarla, en lugar de descubrirlo cuando ya deberia haber salido.

export type ReviewCheckInput = {
  text: string;
  brandId: string;
  /** Publicacion normal o historia. Sin indicarlo es una publicacion normal. */
  format?: PostFormatName;
  /** `scopes`: permisos que Meta concedio a esa conexion (separados por comas); nulo si no se conocen. */
  targets: { name: string; kind: string; status: string; brandId: string | null; scopes?: string | null }[];
  /**
   * Imagenes y videos adjuntos. Un video lleva ademas su tamano, duracion y lo leido del archivo (`videoInfo`, el JSON de
   * PostMedia.videoInfo); sin `kind` se trata como imagen.
   */
  media: { mimeType: string; width: number | null; height: number | null; kind?: "IMAGE" | "VIDEO"; size?: number; durationMs?: number | null; videoInfo?: unknown }[];
};

/** Lista de problemas (vacia si la publicacion esta lista), en español y listos para mostrar. */
export function validatePostForReview(p: ReviewCheckInput): string[] {
  const errors: string[] = [];
  const story = p.format === "STORY";

  // Una historia sale sin texto (su "texto" es solo una nota interna), asi que no se exige.
  if (!story && !p.text.trim()) errors.push("Escribe el texto de la publicación.");
  if (p.targets.length === 0) errors.push("Elige al menos un destino (una página de Facebook o una cuenta de Instagram).");

  for (const t of p.targets) {
    if (t.brandId !== p.brandId) errors.push(`«${t.name}» ya no pertenece a esta marca.`);
    else if (t.status === "REVOKED") errors.push(`«${t.name}» está desconectada: reconéctala en Cuentas o quítala de los destinos.`);
    else if (t.status === "EXPIRED") errors.push(`La conexión de «${t.name}» venció: vuelve a conectar Meta en Cuentas.`);
    else {
      // Se avisa ahora, no cuando ya deberia haber salido: sin este permiso Meta rechazaria la publicacion.
      const missing = missingPublishScope(t.kind, t.scopes);
      if (missing) errors.push(missingScopeMessage(t.name, missing));
    }
  }

  const kinds = p.targets.map((t) => t.kind);
  const videos = p.media.filter((m) => m.kind === "VIDEO");
  if (videos.length > 0) {
    // Reel o historia con video: un solo video, sin imagenes, y los limites de cada red.
    errors.push(...videoMediaErrors(p.media, videos, kinds, story));
    if (!story) {
      const tooLong = lengthError(p.text, kinds);
      if (tooLong) errors.push(tooLong);
    }
    return errors;
  }
  if (story) {
    errors.push(...storyMediaErrors(p.media, kinds));
    return errors;
  }

  const tooLong = lengthError(p.text, kinds);
  if (tooLong) errors.push(tooLong);

  if (p.media.length > MAX_IMAGES_PER_POST) errors.push(`Una publicación admite hasta ${MAX_IMAGES_PER_POST} imágenes y esta tiene ${p.media.length}. Quita ${p.media.length - MAX_IMAGES_PER_POST === 1 ? "una" : p.media.length - MAX_IMAGES_PER_POST}.`);

  if (kinds.includes("INSTAGRAM_PROFILE")) {
    if (p.media.length === 0) errors.push("Instagram necesita una imagen: sube una en el borrador o quita Instagram de los destinos.");
    // Con varias imagenes (carrusel) se revisa cada una y el mensaje dice cual.
    p.media.slice(0, MAX_IMAGES_PER_POST).forEach((image, i) => {
      const problem = instagramImageError({ mimeType: image.mimeType, width: image.width ?? 0, height: image.height ?? 0 });
      if (problem) errors.push(p.media.length > 1 ? `Imagen ${i + 1}: ${problem}` : problem);
    });
  }
  return errors;
}

/** Problemas de un Reel o una historia con video: uno solo y sin imagenes, y dentro de lo que admite cada red. */
function videoMediaErrors(media: ReviewCheckInput["media"], videos: ReviewCheckInput["media"], kinds: string[], story: boolean): string[] {
  const errors: string[] = [];
  const noun = story ? "Una historia" : "Una publicación";
  if (videos.length > MAX_VIDEOS_PER_POST) {
    const extra = videos.length - MAX_VIDEOS_PER_POST;
    errors.push(`${noun} con video lleva un solo video y esta tiene ${videos.length}. Quita ${extra === 1 ? "el que sobra" : `los ${extra} que sobran`} (o crea una publicación por cada video).`);
  }
  if (media.length > videos.length) {
    errors.push(`${noun} con video lleva solo el video, sin imágenes: quita las imágenes (o crea otra ${story ? "historia" : "publicación"} con ellas).`);
  }
  const v = videos[0];
  errors.push(
    ...videoProblems(
      { width: v.width, height: v.height, durationMs: v.durationMs ?? null, size: v.size ?? 0, details: parseVideoDetails(v.videoInfo) },
      { story, kinds },
    ).errors,
  );
  return errors;
}

/** Problemas de la foto de una historia: debe haber exactamente una, y Instagram solo acepta JPG. */
function storyMediaErrors(media: ReviewCheckInput["media"], kinds: string[]): string[] {
  const errors: string[] = [];
  if (media.length === 0) {
    errors.push("Una historia necesita una foto: súbela en el borrador.");
    return errors;
  }
  if (media.length > MAX_IMAGES_PER_STORY) {
    const extra = media.length - MAX_IMAGES_PER_STORY;
    errors.push(`Una historia lleva una sola foto y esta tiene ${media.length}. Quita ${extra === 1 ? "la que sobra" : `las ${extra} que sobran`} (o crea una historia por cada foto).`);
  }
  if (kinds.includes("INSTAGRAM_PROFILE")) {
    const problem = instagramStoryImageError(media[0]);
    if (problem) errors.push(problem);
  }
  return errors;
}
