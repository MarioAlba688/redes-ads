import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { deleteImage, mediaPath, saveImage } from "@/lib/media";
import { MAX_IMAGE_BYTES, readImageInfo } from "@/lib/media-format";
import { isSameOrigin } from "@/lib/same-origin";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Guarda la portada de un video de un borrador: el primer cuadro, que saca el navegador y llega como JPG. Es opcional:
 * Instagram la usa como `cover_url` (sin ella elige un cuadro por su cuenta) y la app la muestra en listas y calendario.
 * Reemplaza a la anterior, si habia.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/posts/[id]/media/[mediaId]/cover">) {
  if (!isSameOrigin(request)) return fail(403, "Origen no permitido.");
  const auth = await authorize("content.create");
  if (!auth.ok) return fail(401, auth.error);

  const { id, mediaId } = await ctx.params;
  const media = await db.postMedia.findFirst({
    where: { id: mediaId, postId: id },
    select: { id: true, kind: true, thumbKey: true, post: { select: { status: true } } },
  });
  if (!media) return fail(404, "Ese video ya no existe.");
  if (media.kind !== "VIDEO") return fail(409, "Solo los videos tienen portada.");
  if (media.post.status !== "DRAFT") return fail(409, "Solo se puede cambiar la portada de un borrador.");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES + 64 * 1024) return fail(413, "La portada pesa más de 8 MB.");

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return fail(400, "No se pudo leer el archivo.");
  }
  if (!(file instanceof File)) return fail(400, "Falta el archivo.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = readImageInfo(bytes);
  if (!info.ok) return fail(400, info.error);
  if (info.info.mimeType !== "image/jpeg") return fail(400, "La portada debe ser una imagen JPG.");

  const storageKey = await saveImage(bytes, info.info);
  try {
    await db.postMedia.update({ where: { id: media.id }, data: { thumbKey: storageKey } });
    if (media.thumbKey) await deleteImage(media.thumbKey);
    await audit("post.media_cover", { userId: auth.user.id, target: id, detail: { bytes: bytes.length, w: info.info.width, h: info.info.height } });
    return NextResponse.json({ url: mediaPath(storageKey) });
  } catch (e) {
    await deleteImage(storageKey); // si no se pudo registrar, no dejamos el archivo huerfano
    console.error("[media] no se pudo guardar la portada", e instanceof Error ? e.message : e);
    return fail(500, "No se pudo guardar la portada. Inténtalo de nuevo.");
  }
}
