import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { deleteImage, imageExists, mediaPath, saveImage } from "@/lib/media";
import { MAX_IMAGE_BYTES, readImageInfo } from "@/lib/media-format";
import { isSameOrigin } from "@/lib/same-origin";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/** Estados en los que el contenido ya salio: ahi la imagen se puede RESTAURAR (no cambiar) si su archivo se perdio. */
const RESTORABLE = ["PUBLISHED", "PARTIAL"];

/**
 * Vuelve a poner el archivo de una imagen cuyo archivo se perdio del servidor (un redespliegue sin volumen, o la
 * publicacion se creo en otra copia de la app). La base de datos la sigue conociendo; solo falta el archivo.
 *
 * No es una forma de cambiar la imagen de una publicacion, asi que:
 *  - solo si el archivo de verdad falta (si esta, no se toca);
 *  - solo en publicaciones que ya salieron (publicada o publicada en parte): lo aprobado y lo programado no se cambia;
 *  - la imagen nueva debe medir exactamente lo mismo que la original (ancho y alto registrados).
 * Los borradores no la necesitan: ahi se quita la imagen y se sube otra.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/posts/[id]/media/[mediaId]">) {
  if (!isSameOrigin(request)) return fail(403, "Origen no permitido.");
  const auth = await authorize("content.create");
  if (!auth.ok) return fail(401, auth.error);

  const { id, mediaId } = await ctx.params;
  const media = await db.postMedia.findFirst({
    where: { id: mediaId, postId: id },
    select: { id: true, storageKey: true, width: true, height: true, post: { select: { status: true } } },
  });
  if (!media) return fail(404, "Esa imagen ya no existe.");
  if (!RESTORABLE.includes(media.post.status)) return fail(409, "Solo se puede restaurar la imagen de una publicación que ya se publicó. En un borrador, quita la imagen y sube otra.");
  if (await imageExists(media.storageKey)) return fail(409, "El archivo de esta imagen está en el servidor: no hace falta restaurarlo.");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES + 64 * 1024) return fail(413, "La imagen pesa más de 8 MB.");

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
  if (media.width !== null && media.height !== null && (info.info.width !== media.width || info.info.height !== media.height)) {
    return fail(400, `La imagen debe ser la original: medir ${media.width} × ${media.height} px y esta mide ${info.info.width} × ${info.info.height}.`);
  }

  const storageKey = await saveImage(bytes, info.info);
  try {
    await db.postMedia.update({ where: { id: media.id }, data: { storageKey, mimeType: info.info.mimeType, size: bytes.length } });
    await deleteImage(media.storageKey); // el nombre viejo ya no existe en disco; por si acaso
    await audit("post.media_restored", { userId: auth.user.id, target: id, detail: { bytes: bytes.length, w: info.info.width, h: info.info.height } });
    return NextResponse.json({ url: mediaPath(storageKey) });
  } catch (e) {
    await deleteImage(storageKey); // si no se pudo registrar, no dejamos el archivo huerfano
    console.error("[media] no se pudo restaurar la imagen", e instanceof Error ? e.message : e);
    return fail(500, "No se pudo guardar la imagen. Inténtalo de nuevo.");
  }
}
