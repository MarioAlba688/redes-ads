import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authorize } from "@/lib/auth/dal";
import { generateToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { META_STATE_COOKIE, metaConfig } from "@/lib/meta/config";
import { buildAuthorizeUrl } from "@/lib/meta/oauth";

/** Empieza la conexion: manda a la persona al cuadro de permisos de Facebook. */
export async function GET() {
  const appUrl = (path: string) => new URL(path, env().APP_URL);

  const auth = await authorize("accounts.manage");
  if (!auth.ok) return NextResponse.redirect(appUrl("/login"));

  if (!metaConfig()) return NextResponse.redirect(appUrl("/cuentas?meta=not_configured"));

  const state = generateToken(24);
  (await cookies()).set(META_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    // Lax: la cookie debe viajar cuando Facebook devuelve a la persona a nuestra pagina.
    sameSite: "lax",
    path: "/api/meta",
    maxAge: 10 * 60,
  });

  return NextResponse.redirect(buildAuthorizeUrl(state));
}
