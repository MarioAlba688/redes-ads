import { timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { syncAdAccount } from "@/lib/ads/sync";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { env } from "@/lib/env";
import { describeInternalError } from "@/lib/errors";
import { GOOGLE_STATE_COOKIE, googleConfig } from "@/lib/google/config";
import { saveGoogleConnection } from "@/lib/google/connection";
import { discoverCustomers } from "@/lib/google/discover";
import { GoogleApiError } from "@/lib/google/errors";
import { exchangeCode } from "@/lib/google/oauth";

function sameValue(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Google devuelve aqui a la persona (con ?code=... o ?error=...) despues del cuadro de permisos. */
export async function GET(request: NextRequest) {
  const appUrl = (path: string) => new URL(path, env().APP_URL);
  const back = (query: string) => NextResponse.redirect(appUrl(`/cuentas?${query}`));

  const auth = await authorize("accounts.manage");
  if (!auth.ok) return NextResponse.redirect(appUrl("/login"));
  if (!googleConfig()) return back("google=not_configured");

  // El `state` se usa una sola vez: lo leemos y borramos la cookie antes de hacer nada mas.
  const store = await cookies();
  const expectedState = store.get(GOOGLE_STATE_COOKIE)?.value;
  store.delete({ name: GOOGLE_STATE_COOKIE, path: "/api/google" });

  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  if (!expectedState || !state || !sameValue(expectedState, state)) {
    await audit("google.connect_rejected", { userId: auth.user.id, detail: { reason: "state" } });
    return back("google=bad_state");
  }

  if (params.get("error")) {
    // La persona cancelo o rechazo los permisos en Google.
    await audit("google.connect_denied", { userId: auth.user.id });
    return back("google=denied");
  }

  const code = params.get("code");
  if (!code) return back("google=error");

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.refreshToken) {
      // Sin token de renovacion la conexion duraria una hora: no se guarda a medias.
      await audit("google.connect_failed", { userId: auth.user.id, detail: { reason: "sin token de renovacion" } });
      return back("google=no_refresh");
    }

    const assets = await discoverCustomers(tokens.accessToken);
    const summary = await saveGoogleConnection({ userId: auth.user.id, tokens: { ...tokens, refreshToken: tokens.refreshToken }, assets });

    if (summary.adAccounts === 0 && summary.skipped.length > 0) {
      await audit("google.connect_failed", { userId: auth.user.id, detail: { skipped: summary.skipped.slice(0, 5), total: summary.skipped.length } });
      return back("google=error");
    }

    await audit("google.connected", {
      userId: auth.user.id,
      target: tokens.email ?? undefined,
      detail: { adAccounts: summary.adAccounts, ...(summary.skipped.length > 0 ? { skipped: summary.skipped.slice(0, 5), skippedTotal: summary.skipped.length } : {}) },
    });

    // Primera descarga de rendimiento (90 dias) despues de responder, para no hacer esperar a la persona.
    after(async () => {
      for (const id of summary.adAccountIds) await syncAdAccount(id, { days: 90 });
    });

    const q = new URLSearchParams({
      google: "connected",
      ads: String(summary.adAccounts),
      ...(summary.skipped.length > 0 ? { skipped: String(summary.skipped.length) } : {}),
    });
    return back(q.toString());
  } catch (e) {
    // Sin tokens ni URLs en el registro: solo los codigos de Google, o la causa de un error nuestro.
    const detail =
      e instanceof GoogleApiError
        ? { status: e.status, google: e.googleStatus ?? null, oauth: e.oauthError ?? null, ads: e.adsValue ?? null }
        : describeInternalError(e);
    console.error("[google] fallo la conexion", detail);
    await audit("google.connect_failed", { userId: auth.user.id, detail });
    if (e instanceof GoogleApiError && e.isProjectNotApproved) return back("google=not_approved");
    if (e instanceof GoogleApiError && e.isBadClient) return back("google=bad_client");
    return back("google=error");
  }
}
