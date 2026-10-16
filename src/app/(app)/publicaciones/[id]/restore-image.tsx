"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui";

/**
 * La base de datos conoce esta imagen pero su archivo ya no esta en el servidor. Permite volver a subir el ORIGINAL
 * (debe medir lo mismo). Para quien puede crear contenido; en publicaciones que ya salieron.
 */
export function RestoreImage({ postId, mediaId, width, height, canRestore }: { postId: string; mediaId: string; width: number | null; height: number | null; canRestore: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/api/posts/${postId}/media/${mediaId}`, { method: "POST", body });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setError(json?.error ?? "No se pudo subir la imagen.");
      else router.refresh();
    } catch {
      setError("No se pudo subir la imagen. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-warning/60 bg-warning-bg px-4 py-3 text-sm">
      <p className="font-medium text-warning">El archivo de esta imagen ya no está en el servidor.</p>
      <p className="text-muted">
        La publicación salió bien; solo falta la copia de la imagen en esta app (se pierde si el servidor se redespliega sin un volumen para las imágenes). Sin ella no se ve aquí ni se puede usar en un anuncio nuevo.
      </p>
      {canRestore ? (
        <div>
          <label htmlFor={`restaurar-${mediaId}`} className="mb-1 block font-medium">
            Volver a subirla{width && height ? ` (la original, de ${width} × ${height} px)` : ""}
          </label>
          <input
            ref={input}
            id={`restaurar-${mediaId}`}
            type="file"
            accept="image/jpeg,image/png"
            disabled={uploading}
            onChange={(e) => onPick(e.target.files?.[0])}
            className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-background"
          />
          {uploading && <p className="mt-1 text-muted">Subiendo…</p>}
        </div>
      ) : (
        <p className="text-muted">Quien edita contenido puede volver a subirla.</p>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
