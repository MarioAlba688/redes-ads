import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authorize } from "@/lib/auth/dal";
import { generateToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { GOOGLE_STATE_COOKIE, googleConfig } from "@/lib/google/config";
import { buildAuthorizeUrl } from "@/lib/google/oauth";

/** Empieza la conexion: manda a la persona al cuadro de permisos de Google. */
export async function GET() {
  const appUrl = (path: string) => new URL(path, env().APP_URL);

  const auth = await authorize("accounts.manage");
  if (!auth.ok) return NextResponse.redirect(appUrl("/login"));

  if (!googleConfig()) return NextResponse.redirect(appUrl("/cuentas?google=not_configured"));

  const state = generateToken(24);
  (await cookies()).set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    // Lax: la cookie debe viajar cuando Google devuelve a la persona a nuestra pagina.
    sameSite: "lax",
    path: "/api/google",
    maxAge: 10 * 60,
  });

  return NextResponse.redirect(buildAuthorizeUrl(state));
}
