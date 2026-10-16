import "server-only";
import { env } from "@/lib/env";

/**
 * Defensa extra para rutas que reciben datos con la cookie de sesion: si el navegador manda la cabecera
 * Origin, tiene que ser la de esta app. (Las acciones de servidor de Next ya hacen esta comprobacion;
 * las rutas /api no.)
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // peticiones sin Origin (herramientas, mismo origen en GET) no son un ataque de navegador
  try {
    return new URL(origin).origin === new URL(env().APP_URL).origin;
  } catch {
    return false;
  }
}
