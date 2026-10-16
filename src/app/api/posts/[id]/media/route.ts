import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { saveImage, deleteImage, mediaPath } from "@/lib/media";
import { MAX_IMAGE_BYTES, readImageInfo } from "@/lib/media-format";
import { isSameOrigin } from "@/lib/same-origin";

const MAX_IMAGES_PER_POST = 1; // por ahora una imagen por publicacion

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/** Sube la imagen de un borrador. Solo quien puede crear contenido, y solo mientras es borrador. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/posts/[id]/media">) {
  if (!isSameOrigin(request)) return fail(403, "Origen no permitido.");
  const auth = await authorize("content.create");
  if (!auth.ok) return fail(401, auth.error);

  const { id } = await ctx.params;
  const post = await db.post.findUnique({ where: { id }, select: { status: true, _count: { select: { media: true } } } });
  if (!post) return fail(404, "Esa publicación ya no existe.");
  if (post.status !== "DRAFT") return fail(409, "Solo se puede cambiar la imagen de un borrador.");
  if (post._count.media >= MAX_IMAGES_PER_POST) {
    return fail(409, "Cada publicación admite una imagen por ahora. Quita la actual para subir otra.");
  }

  // Se mira el tamano declarado antes de leer el archivo entero a memoria.
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

  const storageKey = await saveImage(bytes, info.info);
  try {
    const media = await db.postMedia.create({
      data: {
        postId: id,
        mimeType: info.info.mimeType,
        size: bytes.length,
        width: info.info.width,
        height: info.info.height,
        storageKey,
        originalName: file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 255) || null,
      },
      select: { id: true },
    });
    await audit("post.media_added", { userId: auth.user.id, target: id, detail: { bytes: bytes.length, w: info.info.width, h: info.info.height } });
    return NextResponse.json({ id: media.id, url: mediaPath(storageKey), width: info.info.width, height: info.info.height });
  } catch (e) {
    await deleteImage(storageKey); // si no se pudo registrar, no dejamos el archivo huerfano
    console.error("[media] no se pudo registrar la imagen", e instanceof Error ? e.message : e);
    return fail(500, "No se pudo guardar la imagen. Inténtalo de nuevo.");
  }
}
