import { timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { syncAdAccount } from "@/lib/ads/sync";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { env } from "@/lib/env";
import { describeInternalError } from "@/lib/errors";
import { META_STATE_COOKIE, metaConfig } from "@/lib/meta/config";
import { discoverAssets } from "@/lib/meta/discover";
import { MetaApiError } from "@/lib/meta/errors";
import { exchangeCode, toLongLivedToken } from "@/lib/meta/oauth";
import { saveMetaConnection } from "@/lib/meta/sync";

function sameValue(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Facebook devuelve aqui a la persona (con ?code=... o ?error=...) despues del cuadro de permisos. */
export async function GET(request: NextRequest) {
  const appUrl = (path: string) => new URL(path, env().APP_URL);
  const back = (query: string) => NextResponse.redirect(appUrl(`/cuentas?${query}`));

  const auth = await authorize("accounts.manage");
  if (!auth.ok) return NextResponse.redirect(appUrl("/login"));
  if (!metaConfig()) return back("meta=not_configured");

  // El `state` se usa una sola vez: lo leemos y borramos la cookie antes de hacer nada mas.
  const store = await cookies();
  const expectedState = store.get(META_STATE_COOKIE)?.value;
  store.delete({ name: META_STATE_COOKIE, path: "/api/meta" });

  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  if (!expectedState || !state || !sameValue(expectedState, state)) {
    await audit("meta.connect_rejected", { userId: auth.user.id, detail: { reason: "state" } });
    return back("meta=bad_state");
  }

  if (params.get("error")) {
    // La persona cancelo o rechazo los permisos en Facebook.
    await audit("meta.connect_denied", { userId: auth.user.id });
    return back("meta=denied");
  }

  const code = params.get("code");
  if (!code) return back("meta=error");

  try {
    const shortToken = await exchangeCode(code);
    const longToken = await toLongLivedToken(shortToken);
    const assets = await discoverAssets(longToken.accessToken);
    const summary = await saveMetaConnection({ userId: auth.user.id, assets, userToken: longToken });
    const savedAny = summary.adAccounts + summary.pages + summary.instagram > 0;

    if (!savedAny && summary.skipped.length > 0) {
      // Meta devolvio cuentas pero ninguna se pudo guardar: es un fallo, y el motivo queda en el historial.
      await audit("meta.connect_failed", {
        userId: auth.user.id,
        detail: { skipped: summary.skipped.slice(0, 5), total: summary.skipped.length },
      });
      return back("meta=error");
    }

    await audit("meta.connected", {
      userId: auth.user.id,
      target: assets.user.name,
      detail: {
        adAccounts: summary.adAccounts,
        pages: summary.pages,
        instagram: summary.instagram,
        declined: assets.declinedScopes,
        ...(summary.skipped.length > 0 ? { skipped: summary.skipped.slice(0, 5), skippedTotal: summary.skipped.length } : {}),
      },
    });

    // Primera descarga de rendimiento (90 dias) despues de responder, para no hacer esperar a la persona.
    after(async () => {
      for (const id of summary.adAccountIds) await syncAdAccount(id, { days: 90 });
    });

    const q = new URLSearchParams({
      meta: summary.missingAdsRead ? "partial" : "connected",
      ads: String(summary.adAccounts),
      pages: String(summary.pages),
      ig: String(summary.instagram),
      ...(summary.skipped.length > 0 ? { skipped: String(summary.skipped.length) } : {}),
    });
    return back(q.toString());
  } catch (e) {
    // Sin tokens ni URLs en el registro: el codigo de Meta, o el codigo y la causa de un error nuestro
    // (por ejemplo "Falta ENCRYPTION_KEY"), no la consulta completa.
    const detail =
      e instanceof MetaApiError
        ? { code: e.code ?? null, subcode: e.subcode ?? null, trace: e.fbtraceId ?? null }
        : describeInternalError(e);
    console.error("[meta] fallo la conexion", detail);
    await audit("meta.connect_failed", { userId: auth.user.id, detail });
    return back("meta=error");
  }
}
