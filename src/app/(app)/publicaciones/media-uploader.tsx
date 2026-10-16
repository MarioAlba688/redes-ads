"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { removeMedia } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert } from "@/components/ui";

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

/** Imagen de un borrador: subirla, verla y quitarla. La sube por fetch a /api/posts/[id]/media. */
export function MediaUploader({ postId, media }: { postId: string; media: MediaItem[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removeState, removeAction] = useActionState(removeMedia, undefined);

  async function onPick(picked: File | undefined) {
    if (!picked) return;
    setError(null);
    setNotice(null);
    if (picked.size > 40 * 1024 * 1024) {
      // Ni como JPG cabria en 8 MB, y decodificar un archivo enorme en el navegador lo dejaria colgado.
      setError(`La imagen pesa ${(picked.size / 1024 / 1024).toFixed(0)} MB y el máximo es 8 MB.`);
      if (input.current) input.current.value = "";
      return;
    }
    setUploading(true);
    try {
      // Primero se convierte (un PNG pesado suele quedar bien por debajo del limite como JPG) y luego se mide.
      const { file, converted } = await pngToJpeg(picked);
      if (file.size > MAX_BYTES) {
        setError(`La imagen pesa ${(file.size / 1024 / 1024).toFixed(1)} MB y el máximo es 8 MB.`);
        return;
      }
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/api/posts/${postId}/media`, { method: "POST", body });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setError(json?.error ?? "No se pudo subir la imagen.");
      else {
        if (converted) setNotice("Convertimos tu PNG a JPG automáticamente, que es lo que acepta Instagram.");
        router.refresh();
      }
    } catch {
      setError("No se pudo subir la imagen. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  const current = media[0];

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-semibold">Imagen</h2>
        <p className="text-sm text-muted">
          JPG o PNG de hasta 8 MB (los PNG se convierten solos a JPG, que es lo que acepta Instagram). Para Instagram la imagen debe tener
          formato entre 4:5 (vertical) y 1,91:1 (horizontal).
        </p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && media[0] && <Alert tone="success">{notice}</Alert>}
      {removeState?.error && <Alert>{removeState.error}</Alert>}

      {current ? (
        <div className="flex flex-wrap items-start gap-4">
          {current.missing ? (
            <p className="max-w-sm rounded-lg border border-dashed border-warning/60 bg-warning-bg px-3 py-2 text-sm text-warning">
              El archivo de esta imagen ya no está en el servidor. Quítala y vuelve a subirla.
            </p>
          ) : (
            <>
              {/* Imagen dinamica servida por nuestra ruta /media (con sesion): next/image no aporta nada aqui. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={current.url} alt="Imagen de la publicación" className="max-h-64 max-w-full rounded-lg border border-border" />
            </>
          )}
          <div className="space-y-2 text-sm">
            <p className="text-muted">
              {current.width && current.height ? `${current.width} × ${current.height} px` : ""}
              {current.name ? ` · ${current.name}` : ""}
            </p>
            <form action={removeAction}>
              <input type="hidden" name="mediaId" value={current.id} />
              <SubmitButton variant="secondary" small pendingText="Quitando…">
                Quitar imagen
              </SubmitButton>
            </form>
          </div>
        </div>
      ) : (
        <div>
          <input
            ref={input}
            id="media-file"
            type="file"
            accept="image/jpeg,image/png"
            disabled={uploading}
            onChange={(e) => onPick(e.target.files?.[0])}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-background"
            aria-label="Subir imagen"
          />
          {uploading && <p className="mt-2 text-sm text-muted">Subiendo…</p>}
        </div>
      )}
    </div>
  );
}
