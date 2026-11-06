import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { cleanStaleParts, commitTemp, deleteImage, discardTemp, mediaPath, newTempName, receiveToTemp, saveImage, withFileSource, writeFaststart } from "@/lib/media";
import { MAX_IMAGE_BYTES, maxImagesFor, readImageInfo } from "@/lib/media-format";
import { isSameOrigin } from "@/lib/same-origin";
import { faststartLayout, MAX_VIDEO_BYTES, readVideoInfo, videoProblems } from "@/lib/video-format";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

type DraftState = { status: string; format: string; media: { kind: "IMAGE" | "VIDEO" }[] };

/**
 * Sube una imagen o un video de un borrador (lo deja al final del orden). Solo quien puede crear contenido, y solo
 * mientras es borrador. Una imagen llega como formulario (multipart); un video llega como cuerpo crudo
 * (`Content-Type: video/mp4`, nombre en `x-file-name`) porque es grande y se escribe a disco por partes.
 *
 * `src/proxy.ts` NO debe cubrir esta ruta: con el proxy activo Next guarda en memoria solo los primeros 10 MB del cuerpo
 * y deja pasar el resto sin error, asi que un video grande se guardaria cortado. La propia ruta valida la sesion.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/posts/[id]/media">) {
  if (!isSameOrigin(request)) return fail(403, "Origen no permitido.");
  const auth = await authorize("content.create");
  if (!auth.ok) return fail(401, auth.error);

  const { id } = await ctx.params;
  const post = await db.post.findUnique({ where: { id }, select: { status: true, format: true, media: { select: { kind: true } } } });
  if (!post) return fail(404, "Esa publicación ya no existe.");
  if (post.status !== "DRAFT") return fail(409, "Solo se pueden cambiar las imágenes de un borrador.");

  if (/^video\//i.test(request.headers.get("content-type") ?? "")) return uploadVideo(request, id, post, auth.user.id);
  return uploadImage(request, id, post, auth.user.id);
}

// ---------------------------------------------------------------------------
// Imagen
// ---------------------------------------------------------------------------

async function uploadImage(request: NextRequest, id: string, post: DraftState, userId: string) {
  if (post.media.some((m) => m.kind === "VIDEO")) return fail(409, "Esta publicación ya tiene un video. Quítalo para subir imágenes.");
  const max = maxImagesFor(post.format);
  if (post.media.length >= max) {
    return fail(
      409,
      post.format === "STORY"
        ? "Una historia lleva una sola foto. Quita la que tiene para subir otra."
        : `Una publicación admite hasta ${max} imágenes. Quita alguna para subir otra.`,
    );
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
    // Va al final: una posicion mas que la ultima (las posiciones pueden tener huecos si se quitaron imagenes).
    const last = await db.postMedia.aggregate({ where: { postId: id }, _max: { position: true } });
    const media = await db.postMedia.create({
      data: {
        postId: id,
        mimeType: info.info.mimeType,
        size: bytes.length,
        width: info.info.width,
        height: info.info.height,
        storageKey,
        originalName: cleanName(file.name),
        position: (last._max.position ?? -1) + 1,
      },
      select: { id: true },
    });
    await audit("post.media_added", { userId, target: id, detail: { bytes: bytes.length, w: info.info.width, h: info.info.height } });
    return NextResponse.json({ id: media.id, url: mediaPath(storageKey), width: info.info.width, height: info.info.height });
  } catch (e) {
    await deleteImage(storageKey); // si no se pudo registrar, no dejamos el archivo huerfano
    console.error("[media] no se pudo registrar la imagen", e instanceof Error ? e.message : e);
    return fail(500, "No se pudo guardar la imagen. Inténtalo de nuevo.");
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/** Nombre original del archivo (llega codificado en la cabecera), sin caracteres de control. */
function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // se queda como llego
  }
  return name.replace(/[\u0000-\u001f]/g, "").slice(0, 255) || null;
}

async function uploadVideo(request: NextRequest, id: string, post: DraftState, userId: string) {
  if (post.media.length > 0) {
    return fail(409, post.media.some((m) => m.kind === "VIDEO") ? "La publicación ya tiene un video. Quítalo para subir otro." : "Esta publicación ya tiene imágenes. Quítalas para subir un video.");
  }

  // El tamano declarado manda: se rechaza antes de recibir nada y luego deben llegar exactamente esos bytes.
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared <= 0) return fail(411, "Falta el tamaño del video en la petición. Vuelve a intentarlo desde la pantalla de la publicación.");
  if (declared > MAX_VIDEO_BYTES) return fail(413, `El video pesa ${(declared / 1024 / 1024).toFixed(0)} MB y el máximo es ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
  if (!request.body) return fail(400, "Falta el video.");

  await cleanStaleParts();
  const received = await receiveToTemp(request.body, declared);
  if (!received.ok) return fail(400, received.error);

  let temp = received.temp;
  try {
    let read = await withFileSource(temp, (src) => readVideoInfo(src));
    if (!read.ok) {
      await discardTemp(temp);
      return fail(400, read.error);
    }

    // Meta exige el indice (moov) al inicio y muchos videos de telefono lo traen al final: se reordena aqui.
    let optimized = false;
    if (!read.info.fastStart) {
      const boxes = read.boxes;
      const plan = await withFileSource(temp, (src) => faststartLayout(src, boxes));
      if (!plan.ok || !plan.changed) {
        await discardTemp(temp);
        return fail(400, `El índice del video está al final del archivo y no se pudo reordenar${plan.ok ? "" : ` (${plan.error})`}. Expórtalo con la opción «optimizar para la web» (fast start).`);
      }
      const fixed = newTempName();
      try {
        await writeFaststart(temp, fixed, plan.layout);
      } catch (e) {
        await discardTemp(fixed);
        await discardTemp(temp);
        console.error("[media] no se pudo reordenar el video", e instanceof Error ? e.message : e);
        return fail(500, "No se pudo preparar el video. Inténtalo de nuevo.");
      }
      const again = await withFileSource(fixed, (src) => readVideoInfo(src));
      if (!again.ok || !again.info.fastStart) {
        await discardTemp(fixed);
        await discardTemp(temp);
        return fail(400, "El índice del video está al final del archivo y no se pudo reordenar. Expórtalo con la opción «optimizar para la web» (fast start).");
      }
      await discardTemp(temp);
      temp = fixed;
      read = again;
      optimized = true;
    }

    const { mimeType, extension, width, height, durationMs, size, ...details } = read.info;
    const storageKey = await commitTemp(temp, extension);
    try {
      const row = await db.postMedia.create({
        data: {
          postId: id,
          kind: "VIDEO",
          mimeType,
          size,
          width,
          height,
          durationMs,
          videoInfo: details,
          storageKey,
          originalName: cleanName(request.headers.get("x-file-name")),
          position: 0,
        },
        select: { id: true },
      });
      await audit("post.media_added", { userId, target: id, detail: { kind: "video", bytes: size, w: width, h: height, ms: durationMs, faststart: optimized } });
      // Avisos que no bloquean (p. ej. que no es vertical 9:16), para mostrarlos de inmediato.
      const { warnings } = videoProblems(
        { width, height, durationMs, size, details: { ...details } },
        { story: post.format === "STORY", kinds: ["INSTAGRAM_PROFILE", "FACEBOOK_PAGE"] },
      );
      return NextResponse.json({ id: row.id, kind: "VIDEO", url: mediaPath(storageKey), width, height, durationMs, optimized, warnings });
    } catch (e) {
      await deleteImage(storageKey); // si no se pudo registrar, no dejamos el archivo huerfano
      console.error("[media] no se pudo registrar el video", e instanceof Error ? e.message : e);
      return fail(500, "No se pudo guardar el video. Inténtalo de nuevo.");
    }
  } catch (e) {
    await discardTemp(temp);
    console.error("[media] error al procesar el video", e instanceof Error ? e.message : e);
    return fail(500, "No se pudo procesar el video. Inténtalo de nuevo.");
  }
}
