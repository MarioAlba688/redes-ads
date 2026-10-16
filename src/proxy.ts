import { NextResponse, type NextRequest } from "next/server";

// Nombre de la cookie de sesion (debe coincidir con SESSION_COOKIE en lib/auth/session.ts;
// no se importa de alli porque ese modulo usa la base de datos).
const SESSION_COOKIE = "redes_session";

// /media: la ruta decide por si misma que imagenes son publicas (las de publicaciones programadas o ya publicadas).
const PUBLIC_PREFIXES = ["/login", "/setup", "/invite", "/media"];

/**
 * Chequeo optimista: solo mira si existe la cookie, sin tocar la base de datos.
 * La validacion real de la sesion ocurre en cada pagina y accion (lib/auth/dal.ts).
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!isPublic && !request.cookies.has(SESSION_COOKIE)) {
    // Una llamada de datos (subir una imagen...) sin sesion recibe un 401 en JSON: redirigirla reenviaria el POST a
    // /login, que no lo espera. Solo las navegaciones (GET) se mandan a iniciar sesion.
    if (pathname.startsWith("/api/") && request.method !== "GET" && request.method !== "HEAD") {
      return NextResponse.json({ error: "Tu sesión expiró. Vuelve a iniciar sesión." }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)"],
};
