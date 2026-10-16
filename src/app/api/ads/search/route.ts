import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth/dal";
import * as meta from "@/lib/meta/marketing";
import { classifyAdsError } from "@/lib/promotions/errors";
import { loadAdAccount } from "@/lib/promotions/service";

// Busca intereses y ciudades de Meta para armar la segmentacion de un anuncio. Solo quien puede crear anuncios;
// usa el token de la cuenta publicitaria elegida (nunca sale del servidor).

export async function GET(req: Request) {
  const auth = await authorize("ads.create");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.error.includes("sesión") ? 401 : 403 });

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const q = (url.searchParams.get("q") ?? "").trim();
  const accountId = url.searchParams.get("account") ?? "";
  if ((type !== "interest" && type !== "city") || q.length < 2 || q.length > 80 || !accountId) {
    return NextResponse.json({ error: "Escribe al menos 2 letras." }, { status: 400 });
  }

  const loaded = await loadAdAccount(accountId);
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: 400 });

  try {
    const token = loaded.account.auth.token;
    const results = type === "interest" ? await meta.searchInterests(token, q) : await meta.searchCities(token, q);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: classifyAdsError(e).message }, { status: 502 });
  }
}
