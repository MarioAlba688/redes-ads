import { getSessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { parseRange } from "@/lib/http-range";
import { MEDIA_KEY_RE, readMediaRange, statMedia } from "@/lib/media";

// Mientras una publicacion espera su hora, se esta publicando o ya salio, su imagen o su video tiene que poder
// descargarse sin iniciar sesion: Meta lo descarga desde aqui para publicar en Instagram (y Facebook, si se le da la URL).
// El resto del tiempo (borradores, en revision...) solo lo ven personas con sesion.
const PUBLIC_WHILE = ["SCHEDULED", "PUBLISHING", "PUBLISHED", "PARTIAL"];

const notFound = () => new Response("No encontrado", { status: 404 });

/**
 * Sirve el archivo por partes (un video puede pesar decenas de MB: nunca se carga entero en memoria) y atiende `Range`
 * (los navegadores lo piden para reproducir y avanzar en un video) y `HEAD`. Sirve imagenes, videos y portadas.
 */
async function serve(request: Request, key: string, headOnly: boolean): Promise<Response> {
  if (!MEDIA_KEY_RE.test(key)) return notFound();

  const media = await db.postMedia.findFirst({
    where: { OR: [{ storageKey: key }, { thumbKey: key }] },
    select: { mimeType: true, thumbKey: true, post: { select: { status: true } } },
  });
  if (!media) return notFound();

  const user = await getSessionUser();
  const isPublic = PUBLIC_WHILE.includes(media.post.status);
  if (!user && !isPublic) return notFound();

  const file = await statMedia(key);
  if (!file) return notFound();

  const range = parseRange(request.headers.get("range"), file.size);
  const headers: Record<string, string> = {
    // La portada de un video es siempre JPG; lo demas, el tipo registrado.
    "content-type": media.thumbKey === key ? "image/jpeg" : media.mimeType,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    // Con sesion: nunca en cache compartida. Sin sesion (publica): cache corta.
    "cache-control": user ? "private, no-store" : "public, max-age=300",
  };
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${file.size}` } });

  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  const length = file.size === 0 ? 0 : end - start + 1;
  headers["content-length"] = String(length);
  if (range) headers["content-range"] = `bytes ${start}-${end}/${file.size}`;
  const status = range ? 206 : 200;

  if (headOnly || length === 0) return new Response(null, { status, headers });
  const body = readMediaRange(key, start, end);
  if (!body) return notFound();
  return new Response(body, { status, headers });
}

export async function GET(request: Request, ctx: RouteContext<"/media/[key]">) {
  const { key } = await ctx.params;
  return serve(request, key, false);
}

export async function HEAD(request: Request, ctx: RouteContext<"/media/[key]">) {
  const { key } = await ctx.params;
  return serve(request, key, true);
}
