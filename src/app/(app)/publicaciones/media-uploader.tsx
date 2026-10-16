"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { moveMedia, removeMedia } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert } from "@/components/ui";
import { MAX_IMAGES_PER_POST } from "@/lib/media-format";

export type MediaItem = {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  name: string | null;
  /** La base de datos la conoce pero su archivo ya no esta en el servidor. */
  missing?: boolean;
};

const MAX_BYTES = 8 * 1024 * 1024;

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

/**
 * Imagenes de un borrador: subir una o varias a la vez, verlas, cambiar su orden y quitarlas. Se suben una tras otra
 * (en el orden en que se eligieron, que es el orden de la publicacion) por fetch a /api/posts/[id]/media.
 */
export function MediaUploader({ postId, media }: { postId: string; media: MediaItem[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [removeState, removeAction] = useActionState(removeMedia, undefined);
  const [moveState, moveAction] = useActionState(moveMedia, undefined);

  const uploading = progress !== null;
  const room = MAX_IMAGES_PER_POST - media.length;

  async function onPick(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (picked.length === 0) return;
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
    if (skipped > 0) parts.push(`Una publicación admite hasta ${MAX_IMAGES_PER_POST} imágenes: se subieron las primeras ${files.length} y ${skipped === 1 ? "se dejó 1 fuera" : `se dejaron ${skipped} fuera`}.`);
    if (parts.length) setNotice(parts.join(" "));
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-semibold">Imágenes</h2>
        <p className="text-sm text-muted">
          JPG o PNG de hasta 8 MB cada una (los PNG se convierten solos a JPG, que es lo que acepta Instagram). Puedes subir hasta {MAX_IMAGES_PER_POST}: con varias, Facebook las
          publica juntas y Instagram como carrusel. La primera es la portada. Para Instagram cada imagen debe tener formato entre 4:5 (vertical) y 1,91:1 (horizontal), y puede
          recortarlas todas con la proporción de la primera.
        </p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && media.length > 0 && <Alert tone="success">{notice}</Alert>}
      {removeState?.error && <Alert>{removeState.error}</Alert>}
      {moveState?.error && <Alert>{moveState.error}</Alert>}

      {media.length > 0 && (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {media.map((m, i) => (
            <li key={m.id} className="min-w-0 space-y-2 rounded-lg border border-border bg-surface p-2">
              <p className="text-xs font-medium text-muted">{i === 0 ? "1 · Portada" : i + 1}</p>
              {m.missing ? (
                <p className="rounded-lg border border-dashed border-warning/60 bg-warning-bg px-2 py-2 text-xs text-warning">
                  El archivo ya no está en el servidor. Quítala y vuelve a subirla.
                </p>
              ) : (
                <>
                  {/* Imagen dinamica servida por nuestra ruta /media (con sesion): next/image no aporta nada aqui. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.url} alt={media.length > 1 ? `Imagen ${i + 1} de la publicación` : "Imagen de la publicación"} className="h-36 w-full rounded-md border border-border object-cover" />
                </>
              )}
              <p className="truncate text-xs text-muted" title={m.name ?? undefined}>
                {m.width && m.height ? `${m.width} × ${m.height} px` : ""}
                {m.name ? ` · ${m.name}` : ""}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {media.length > 1 && (
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
                  <SubmitButton variant="secondary" small pendingText="Quitando…" aria-label={`Quitar imagen ${i + 1}`}>
                    Quitar
                  </SubmitButton>
                </form>
              </div>
            </li>
          ))}
        </ol>
      )}

      {room > 0 ? (
        <div>
          <input
            ref={input}
            id="media-file"
            type="file"
            multiple
            accept="image/jpeg,image/png"
            disabled={uploading}
            onChange={(e) => onPick(e.target.files)}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-background"
            aria-label={media.length > 0 ? "Agregar más imágenes" : "Subir imágenes"}
          />
          <p className="mt-1 text-xs text-muted">
            {media.length === 0 ? `Puedes elegir varias a la vez (hasta ${MAX_IMAGES_PER_POST}).` : `Caben ${room} más.`}
          </p>
          {uploading && (
            <p className="mt-2 text-sm text-muted" role="status">
              Subiendo {Math.min(progress.done + 1, progress.total)} de {progress.total}…
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">Llegaste al máximo de {MAX_IMAGES_PER_POST} imágenes. Quita alguna para subir otra.</p>
      )}
    </div>
  );
}
