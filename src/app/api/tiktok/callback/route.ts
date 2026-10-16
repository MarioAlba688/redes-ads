import { timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { syncAdAccount } from "@/lib/ads/sync";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { env } from "@/lib/env";
import { describeInternalError } from "@/lib/errors";
import { TIKTOK_STATE_COOKIE, tiktokConfig } from "@/lib/tiktok/config";
import { saveTikTokConnection } from "@/lib/tiktok/connection";
import { discoverAdvertisers } from "@/lib/tiktok/discover";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { exchangeAuthCode } from "@/lib/tiktok/oauth";

function sameValue(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** TikTok devuelve aqui a la persona (con ?auth_code=... o ?error=...) despues de autorizar. */
export async function GET(request: NextRequest) {
  const appUrl = (path: string) => new URL(path, env().APP_URL);
  const back = (query: string) => NextResponse.redirect(appUrl(`/cuentas?${query}`));

  const auth = await authorize("accounts.manage");
  if (!auth.ok) return NextResponse.redirect(appUrl("/login"));
  if (!tiktokConfig()) return back("tiktok=not_configured");

  // El `state` se usa una sola vez: lo leemos y borramos la cookie antes de hacer nada mas.
  const store = await cookies();
  const expectedState = store.get(TIKTOK_STATE_COOKIE)?.value;
  store.delete({ name: TIKTOK_STATE_COOKIE, path: "/api/tiktok" });

  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  if (!expectedState || !state || !sameValue(expectedState, state)) {
    await audit("tiktok.connect_rejected", { userId: auth.user.id, detail: { reason: "state" } });
    return back("tiktok=bad_state");
  }

  if (params.get("error")) {
    // La persona cancelo la autorizacion en TikTok.
    await audit("tiktok.connect_denied", { userId: auth.user.id });
    return back("tiktok=denied");
  }

  const authCode = params.get("auth_code") ?? params.get("code");
  if (!authCode) return back("tiktok=error");

  try {
    const token = await exchangeAuthCode(authCode);
    const assets = await discoverAdvertisers(token.accessToken, token.advertiserIds);
    const summary = await saveTikTokConnection({ userId: auth.user.id, token, assets });

    if (summary.adAccounts === 0 && summary.skipped.length > 0) {
      await audit("tiktok.connect_failed", { userId: auth.user.id, detail: { skipped: summary.skipped.slice(0, 5), total: summary.skipped.length } });
      return back("tiktok=error");
    }

    await audit("tiktok.connected", {
      userId: auth.user.id,
      detail: { adAccounts: summary.adAccounts, ...(summary.skipped.length > 0 ? { skipped: summary.skipped.slice(0, 5), skippedTotal: summary.skipped.length } : {}) },
    });

    // Primera descarga de rendimiento (90 dias) despues de responder, para no hacer esperar a la persona.
    after(async () => {
      for (const id of summary.adAccountIds) await syncAdAccount(id, { days: 90 });
    });

    const q = new URLSearchParams({
      tiktok: "connected",
      ads: String(summary.adAccounts),
      ...(summary.skipped.length > 0 ? { skipped: String(summary.skipped.length) } : {}),
    });
    return back(q.toString());
  } catch (e) {
    // Sin tokens ni URLs en el registro: solo el codigo de TikTok, o la causa de un error nuestro.
    const detail = e instanceof TikTokApiError ? { status: e.status, code: e.code } : describeInternalError(e);
    console.error("[tiktok] fallo la conexion", detail);
    await audit("tiktok.connect_failed", { userId: auth.user.id, detail });
    return back("tiktok=error");
  }
}
