import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { authorize } from "@/lib/auth/dal";
import { generateToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { TIKTOK_STATE_COOKIE, tiktokConfig } from "@/lib/tiktok/config";
import { buildAuthorizeUrl } from "@/lib/tiktok/oauth";

/** Empieza la conexion: manda a la persona a la pantalla de autorizacion de TikTok For Business. */
export async function GET() {
  const appUrl = (path: string) => new URL(path, env().APP_URL);

  const auth = await authorize("accounts.manage");
  if (!auth.ok) return NextResponse.redirect(appUrl("/login"));

  if (!tiktokConfig()) return NextResponse.redirect(appUrl("/cuentas?tiktok=not_configured"));

  const state = generateToken(24);
  (await cookies()).set(TIKTOK_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    // Lax: la cookie debe viajar cuando TikTok devuelve a la persona a nuestra pagina.
    sameSite: "lax",
    path: "/api/tiktok",
    maxAge: 10 * 60,
  });

  return NextResponse.redirect(buildAuthorizeUrl(state));
}
