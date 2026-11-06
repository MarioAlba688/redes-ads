"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { moveMedia, removeMedia } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert } from "@/components/ui";
import { maxImagesFor, storyRatioNote } from "@/lib/media-format";
import type { PostFormatName } from "@/lib/posts";
import { MAX_VIDEO_BYTES, videoProblems } from "@/lib/video-format";

export type MediaItem = {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  name: string | null;
  /** La base de datos la conoce pero su archivo ya no esta en el servidor. */
  missing?: boolean;
  /** Sin indicarlo es una imagen. */
  kind?: "IMAGE" | "VIDEO";
  /** Solo video. */
  durationMs?: number | null;
  size?: number;
  /** Solo video: portada (primer cuadro), si hay. */
  coverUrl?: string | null;
};

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_MB = MAX_VIDEO_BYTES / 1024 / 1024;

/**
 * Convierte un PNG a JPG en el navegador (fondo blanco donde habia transparencia) porque Instagram solo acepta JPG.
 * Si algo falla (archivo danado, imagen enorme, navegador sin soporte) devuelve el original y el servidor decide.
 */
async function pngToJpeg(file: File): Promise<{ file: File; converted: boolean }> {
  if (file.type !== "image/png" && !/\.png$/i.test(file.name)) return { file, converted: false };
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { file, converted: false };
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    if (!blob || blob.size === 0) return { file, converted: false };
    return { file: new File([blob], `${file.name.replace(/\.png$/i, "")}.jpg`, { type: "image/jpeg" }), converted: true };
  } catch {
    return { file, converted: false };
  }
}

/** Sube un archivo (ya convertido si hacia falta). Devuelve el motivo si no se pudo, o null si quedo guardado. */
async function uploadOne(postId: string, picked: File): Promise<{ error: string | null; converted: boolean }> {
  if (picked.size > 40 * 1024 * 1024) {
    // Ni como JPG cabria en 8 MB, y decodificar un archivo enorme en el navegador lo dejaria colgado.
    return { error: `pesa ${(picked.size / 1024 / 1024).toFixed(0)} MB y el máximo es 8 MB.`, converted: false };
  }
  // Primero se convierte (un PNG pesado suele quedar bien por debajo del limite como JPG) y luego se mide.
  const { file, converted } = await pngToJpeg(picked);
  if (file.size > MAX_BYTES) return { error: `pesa ${(file.size / 1024 / 1024).toFixed(1)} MB y el máximo es 8 MB.`, converted };
  const body = new FormData();
  body.set("file", file);
  const res = await fetch(`/api/posts/${postId}/media`, { method: "POST", body });
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) return { error: json?.error ?? "no se pudo subir.", converted };
  return { error: null, converted };
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

const isVideoFile = (f: File) => f.type.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(f.name);

/** Saca el primer cuadro del video como JPG (para la portada). null si el navegador no puede leer ese video. */
async function captureCover(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    const waitFor = (event: "loadeddata" | "seeked", then?: () => void) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("tiempo agotado")), 15_000);
        video.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
        video.addEventListener("error", () => (clearTimeout(timer), reject(new Error("no se pudo leer"))), { once: true });
        then?.();
      });
    await waitFor("loadeddata");
    // Un poco despues del inicio: el primer instante suele ser negro.
    const at = Math.min(0.5, (Number.isFinite(video.duration) ? video.duration : 1) / 4);
    await waitFor("seeked", () => {
      video.currentTime = at;
    });
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 1920 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob && blob.size > 0 && blob.size <= MAX_BYTES ? blob : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type VideoUploadResult = { ok: true; id: string; warnings: string[]; optimized: boolean } | { ok: false; error: string };

/**
 * Sube el video como cuerpo crudo (no como formulario): el servidor lo escribe a disco por partes. Se usa XMLHttpRequest
 * y no fetch porque solo XHR informa del avance de la subida.
 */
function uploadVideo(postId: string, file: File, onProgress: (fraction: number) => void): Promise<VideoUploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/posts/${postId}/media`);
    xhr.setRequestHeader("content-type", file.type || (/\.mov$/i.test(file.name) ? "video/quicktime" : "video/mp4"));
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.timeout = 20 * 60_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => resolve({ ok: false, error: "se cortó la conexión mientras se subía. Revisa tu internet e inténtalo de nuevo." });
    xhr.ontimeout = () => resolve({ ok: false, error: "la subida tardó demasiado. Prueba con un video más liviano o una mejor conexión." });
    xhr.onload = () => {
      let json: { id?: string; error?: string; warnings?: string[]; optimized?: boolean } | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // respuesta que no es JSON (p. ej. un error del servidor web): se explica abajo
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.id) resolve({ ok: true, id: json.id, warnings: json.warnings ?? [], optimized: json.optimized === true });
      else if (xhr.status === 413) resolve({ ok: false, error: `el servidor rechazó el tamaño del video (el máximo es ${MAX_VIDEO_MB} MB; si es menos, el servidor web de tu hosting limita las subidas).` });
      else resolve({ ok: false, error: json?.error ?? "no se pudo subir." });
    };
    xhr.send(file);
  });
}

/** Sube la portada del video; es opcional, asi que un fallo no impide seguir. */
async function uploadCover(postId: string, mediaId: string, cover: Blob): Promise<boolean> {
  try {
    const body = new FormData();
    body.set("file", new File([cover], "portada.jpg", { type: "image/jpeg" }));
    const res = await fetch(`/api/posts/${postId}/media/${mediaId}/cover`, { method: "POST", body });
    return res.ok;
  } catch {
    return false;
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
const secondsLabel = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1).replace(".", ",")} s`;

/**
 * Imagenes o video de un borrador. Imagenes: subir una o varias a la vez, verlas, cambiar su orden y quitarlas (se suben
 * una tras otra, en el orden en que se eligieron, por fetch a /api/posts/[id]/media). Video: uno solo, con barra de
 * avance y portada sacada del primer cuadro. En una historia es una sola foto o un solo video.
 */
export function MediaUploader({ postId, media, format = "FEED" }: { postId: string; media: MediaItem[]; format?: PostFormatName }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [videoStep, setVideoStep] = useState<{ phase: "preparing" | "uploading" | "processing" | "cover"; fraction: number; name: string } | null>(null);
  const [removeState, removeAction] = useActionState(removeMedia, undefined);
  const [moveState, moveAction] = useActionState(moveMedia, undefined);

  const story = format === "STORY";
  const hasVideo = media.some((m) => m.kind === "VIDEO");
  const max = maxImagesFor(format);
  const uploading = progress !== null || videoStep !== null;
  const room = max - media.length;
  // Una foto que no es vertical 9:16 no se rechaza: se avisa de como se vera.
  const first = media[0];
  const ratioNote = story && !hasVideo && first?.width && first?.height ? storyRatioNote({ width: first.width, height: first.height }) : null;
  // Lo mismo para un video (y su duracion no se revisa aqui: depende de los destinos y se revisa al enviar a revision).
  const videoItem = media.find((m) => m.kind === "VIDEO");
  const videoNote = videoItem
    ? videoProblems({ width: videoItem.width, height: videoItem.height, durationMs: videoItem.durationMs ?? null, size: videoItem.size ?? 0, details: null }, { story, kinds: [] }).warnings[0] ?? null
    : null;

  async function onPickVideo(file: File) {
    setError(null);
    setNotice(null);
    if (media.length > 0) {
      setError(hasVideo ? "La publicación ya tiene un video. Quítalo para subir otro." : "Esta publicación ya tiene imágenes. Quítalas para subir un video.");
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setError(`«${file.name}» pesa ${mb(file.size)} y el máximo es ${MAX_VIDEO_MB} MB. Expórtalo con menos calidad o recórtalo.`);
      return;
    }
    try {
      setVideoStep({ phase: "preparing", fraction: 0, name: file.name });
      const cover = await captureCover(file);
      setVideoStep({ phase: "uploading", fraction: 0, name: file.name });
      const result = await uploadVideo(postId, file, (fraction) => setVideoStep({ phase: fraction >= 1 ? "processing" : "uploading", fraction, name: file.name }));
      if (!result.ok) {
        setError(`«${file.name}»: ${result.error}`);
        return;
      }
      let coverFailed = false;
      if (cover) {
        setVideoStep({ phase: "cover", fraction: 1, name: file.name });
        coverFailed = !(await uploadCover(postId, result.id, cover));
      }
      const parts: string[] = [];
      if (result.optimized) parts.push("Reordenamos el video para que Meta lo acepte (su índice estaba al final del archivo).");
      if (!cover || coverFailed) parts.push("No se pudo sacar la portada del video: Instagram elegirá un cuadro por su cuenta.");
      for (const w of result.warnings) parts.push(w);
      if (parts.length) setNotice(parts.join(" "));
    } catch {
      setError(`«${file.name}»: no se pudo subir. Revisa tu conexión e inténtalo de nuevo.`);
    } finally {
      setVideoStep(null);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  }

  async function onPick(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (picked.length === 0) return;
    // Un video va solo: se sube el primero y no se mezcla con imagenes.
    const videos = picked.filter(isVideoFile);
    if (videos.length > 0) {
      if (picked.length > 1) {
        setError("Un video se sube solo: elige un video o varias imágenes, no las dos cosas a la vez.");
        if (input.current) input.current.value = "";
        return;
      }
      await onPickVideo(videos[0]);
      return;
    }
    if (hasVideo) {
      setError("Esta publicación ya tiene un video. Quítalo para subir imágenes.");
      if (input.current) input.current.value = "";
      return;
    }
    setError(null);
    setNotice(null);

    const files = picked.slice(0, Math.max(room, 0));
    const skipped = picked.length - files.length;
    const problems: string[] = [];
    let converted = 0;
    setProgress({ done: 0, total: files.length });
    try {
      for (const [i, picked1] of files.entries()) {
        try {
          const r = await uploadOne(postId, picked1);
          if (r.converted) converted++;
          if (r.error) problems.push(`«${picked1.name}»: ${r.error}`);
        } catch {
          problems.push(`«${picked1.name}»: no se pudo subir. Revisa tu conexión e inténtalo de nuevo.`);
        }
        setProgress({ done: i + 1, total: files.length });
      }
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
    if (problems.length) setError(problems.join(" "));
    const parts: string[] = [];
    if (converted) parts.push(`${converted === 1 ? "Convertimos tu PNG" : `Convertimos ${converted} PNG`} a JPG automáticamente, que es lo que acepta Instagram.`);
    if (skipped > 0) {
      parts.push(
        story
          ? "Una historia lleva una sola foto: se subió la primera y las demás se dejaron fuera."
          : `Una publicación admite hasta ${max} imágenes: se subieron las primeras ${files.length} y ${skipped === 1 ? "se dejó 1 fuera" : `se dejaron ${skipped} fuera`}.`,
      );
    }
    if (parts.length) setNotice(parts.join(" "));
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-semibold">{story ? "Foto o video de la historia" : "Imágenes o video"}</h2>
        {story ? (
          <p className="text-sm text-muted">
            Una sola foto (JPG o PNG de hasta 8 MB; los PNG se convierten solos a JPG, que es lo que acepta Instagram) o un solo video (MP4 o MOV de 3 a 60 segundos y hasta {MAX_VIDEO_MB} MB). Se ve mejor
            en vertical 9:16, por ejemplo 1080 × 1920 píxeles. Por la API de Meta la historia sale tal cual la subes: sin texto, sin enlace y sin stickers, así que lo que quieras que se vea tiene que ir
            dentro de la imagen o del video.
          </p>
        ) : (
          <p className="text-sm text-muted">
            Imágenes: JPG o PNG de hasta 8 MB cada una (los PNG se convierten solos a JPG, que es lo que acepta Instagram). Puedes subir hasta {max}: con varias, Facebook las publica juntas y Instagram como
            carrusel. La primera es la portada. Para Instagram cada imagen debe tener formato entre 4:5 (vertical) y 1,91:1 (horizontal), y puede recortarlas todas con la proporción de la primera.
            Video: uno solo (MP4 o MOV de hasta {MAX_VIDEO_MB} MB) y sale como Reel; no se mezcla con imágenes. Los Reels de Instagram duran de 3 segundos a 15 minutos y los de Facebook de 3 a 90 segundos; se ven
            mejor en vertical 9:16.
          </p>
        )}
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && media.length > 0 && <Alert tone="success">{notice}</Alert>}
      {ratioNote && <Alert tone="warning">{ratioNote}</Alert>}
      {videoNote && <Alert tone="warning">{videoNote}</Alert>}
      {removeState?.error && <Alert>{removeState.error}</Alert>}
      {moveState?.error && <Alert>{moveState.error}</Alert>}

      {media.length > 0 && (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {media.map((m, i) => {
            const isVideo = m.kind === "VIDEO";
            return (
              <li key={m.id} className={`min-w-0 space-y-2 rounded-lg border border-border bg-surface p-2 ${isVideo ? "col-span-2 sm:col-span-2" : ""}`}>
                <p className="text-xs font-medium text-muted">{isVideo ? "Video" : story ? "Historia" : i === 0 ? "1 · Portada" : i + 1}</p>
                {m.missing ? (
                  <p className="rounded-lg border border-dashed border-warning/60 bg-warning-bg px-2 py-2 text-xs text-warning">
                    El archivo ya no está en el servidor. Quítalo y vuelve a subirlo.
                  </p>
                ) : isVideo ? (
                  <video
                    src={m.url}
                    poster={m.coverUrl ?? undefined}
                    controls
                    preload="metadata"
                    playsInline
                    aria-label={story ? "Video de la historia" : "Video de la publicación"}
                    className="max-h-72 w-full rounded-md border border-border bg-black object-contain"
                  />
                ) : (
                  <>
                    {/* Imagen dinamica servida por nuestra ruta /media (con sesion): next/image no aporta nada aqui. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={m.url}
                      alt={story ? "Foto de la historia" : media.length > 1 ? `Imagen ${i + 1} de la publicación` : "Imagen de la publicación"}
                      className="h-36 w-full rounded-md border border-border object-cover"
                    />
                  </>
                )}
                <p className="truncate text-xs text-muted" title={m.name ?? undefined}>
                  {[
                    m.width && m.height ? `${m.width} × ${m.height} px` : null,
                    isVideo && m.durationMs ? secondsLabel(m.durationMs) : null,
                    isVideo && m.size ? mb(m.size) : null,
                    m.name,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {media.length > 1 && !isVideo && (
                    <>
                      <form action={moveAction}>
                        <input type="hidden" name="mediaId" value={m.id} />
                        <input type="hidden" name="direction" value="before" />
                        <SubmitButton variant="secondary" small pendingText="…" disabled={i === 0} aria-label={`Mover la imagen ${i + 1} antes`}>
                          ←
                        </SubmitButton>
                      </form>
                      <form action={moveAction}>
                        <input type="hidden" name="mediaId" value={m.id} />
                        <input type="hidden" name="direction" value="after" />
                        <SubmitButton variant="secondary" small pendingText="…" disabled={i === media.length - 1} aria-label={`Mover la imagen ${i + 1} después`}>
                          →
                        </SubmitButton>
                      </form>
                    </>
                  )}
                  <form action={removeAction}>
                    <input type="hidden" name="mediaId" value={m.id} />
                    <SubmitButton
                      variant="secondary"
                      small
                      pendingText="Quitando…"
                      aria-label={isVideo ? "Quitar el video" : story ? "Quitar la foto de la historia" : `Quitar imagen ${i + 1}`}
                    >
                      Quitar
                    </SubmitButton>
                  </form>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {room > 0 && !hasVideo ? (
        <div>
          <input
            ref={input}
            id="media-file"
            type="file"
            // Imagenes: varias a la vez. Un video se sube solo.
            multiple={!story}
            accept="image/jpeg,image/png,video/mp4,video/quicktime,.mp4,.mov,.m4v"
            disabled={uploading}
            onChange={(e) => onPick(e.target.files)}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-background"
            aria-label={story ? "Subir la foto o el video de la historia" : media.length > 0 ? "Agregar más imágenes" : "Subir imágenes o un video"}
          />
          <p className="mt-1 text-xs text-muted">
            {story
              ? "Elige la foto o el video de la historia."
              : media.length === 0
                ? `Puedes elegir varias imágenes a la vez (hasta ${max}) o un video.`
                : `Caben ${room} más.`}
          </p>
          {progress !== null && (
            <p className="mt-2 text-sm text-muted" role="status">
              Subiendo {Math.min(progress.done + 1, progress.total)} de {progress.total}…
            </p>
          )}
          {videoStep !== null && (
            <div className="mt-2 space-y-1" role="status">
              <p className="text-sm text-muted">
                {videoStep.phase === "preparing" && `Preparando «${videoStep.name}»…`}
                {videoStep.phase === "uploading" && `Subiendo «${videoStep.name}»… ${Math.round(videoStep.fraction * 100)} %`}
                {videoStep.phase === "processing" && "Revisando el video en el servidor (formato, duración y orden del archivo)…"}
                {videoStep.phase === "cover" && "Guardando la portada…"}
              </p>
              <progress className="h-2 w-full" max={100} value={Math.round(videoStep.fraction * 100)} aria-label="Avance de la subida del video" />
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">
          {hasVideo
            ? "La publicación ya tiene su video. Quítalo para subir imágenes u otro video."
            : story
              ? "La historia ya tiene su foto. Quítala para subir otra."
              : `Llegaste al máximo de ${max} imágenes. Quita alguna para subir otra.`}
        </p>
      )}
    </div>
  );
}
