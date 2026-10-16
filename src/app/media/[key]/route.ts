import { getSessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { MEDIA_KEY_RE, readImage } from "@/lib/media";

// Mientras una publicacion espera su hora, se esta publicando o ya salio, su imagen tiene que poder
// descargarse sin iniciar sesion: Meta la descarga desde aqui para publicar en Instagram.
// El resto del tiempo (borradores, en revision...) solo la ven personas con sesion.
const PUBLIC_WHILE = ["SCHEDULED", "PUBLISHING", "PUBLISHED", "PARTIAL"];

const notFound = () => new Response("No encontrado", { status: 404 });

export async function GET(_request: Request, ctx: RouteContext<"/media/[key]">) {
  const { key } = await ctx.params;
  if (!MEDIA_KEY_RE.test(key)) return notFound();

  const media = await db.postMedia.findUnique({
    where: { storageKey: key },
    select: { mimeType: true, post: { select: { status: true } } },
  });
  if (!media) return notFound();

  const user = await getSessionUser();
  const isPublic = PUBLIC_WHILE.includes(media.post.status);
  if (!user && !isPublic) return notFound();

  const bytes = await readImage(key);
  if (!bytes) return notFound();

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": media.mimeType,
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      // Con sesion: nunca en cache compartida. Sin sesion (publica): cache corta.
      "cache-control": user ? "private, no-store" : "public, max-age=300",
    },
  });
}
