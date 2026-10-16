import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tiktokRequest } from "@/lib/tiktok/client";
import { discoverAdvertisers } from "@/lib/tiktok/discover";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { dateChunks, fetchCampaignInsights, normalizeRow } from "@/lib/tiktok/insights";
import { buildAuthorizeUrl, exchangeAuthCode } from "@/lib/tiktok/oauth";
import { setMetaEnv } from "./helpers/meta-env";

const APP_ID = "7123456789012345678";
const SECRET = "secreto-de-prueba-de-tiktok";

beforeEach(() => {
  setMetaEnv({ TIKTOK_APP_ID: APP_ID, TIKTOK_APP_SECRET: SECRET, TIKTOK_API_BASE_URL: undefined });
});
afterEach(() => vi.unstubAllGlobals());

type Call = { url: URL; init: RequestInit };
/** Sustituye fetch: `handler` recibe cada llamada y devuelve el cuerpo (TikTok responde 200 incluso con errores). */
function stubTikTok(handler: (call: Call, n: number) => unknown | Error, status = 200) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const call = { url: new URL(String(input)), init };
      calls.push(call);
      const r = handler(call, calls.length);
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}
const ok = (data: unknown) => ({ code: 0, message: "OK", data });
/** El error con que termina una llamada (o null si salio bien), tipado. */
const caught = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as TikTokApiError;

describe("autorizacion de TikTok", () => {
  it("manda a la persona a la pantalla de autorizacion con el ID de la app, la URL de retorno y el state", () => {
    const url = new URL(buildAuthorizeUrl("estado-123"));
    expect(`${url.origin}${url.pathname}`).toBe("https://business-api.tiktok.com/portal/auth");
    expect(url.searchParams.get("app_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/tiktok/callback");
    expect(url.searchParams.get("state")).toBe("estado-123");
    expect(url.toString()).not.toContain(SECRET);
  });

  it("cambia el codigo por el token con un POST JSON (secreto en el cuerpo, nunca en la URL)", async () => {
    const calls = stubTikTok(() => ok({ access_token: "TT-TOKEN", advertiser_ids: ["7001", 7002], scope: [1, 4] }));
    const t = await exchangeAuthCode("CODIGO");
    expect(calls[0].url.pathname).toBe("/open_api/v1.3/oauth2/access_token/");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ app_id: APP_ID, secret: SECRET, auth_code: "CODIGO" });
    expect(calls[0].url.toString()).not.toContain(SECRET);
    expect(t).toEqual({ accessToken: "TT-TOKEN", advertiserIds: ["7001", "7002"], scopes: ["1", "4"] });
  });

  it("sin token en la respuesta es un error", async () => {
    stubTikTok(() => ok({ advertiser_ids: [] }));
    await expect(exchangeAuthCode("x")).rejects.toThrow(/token/);
  });
});

describe("cliente de TikTok", () => {
  it("TikTok responde HTTP 200 con errores: lo que manda es `code`", async () => {
    stubTikTok(() => ({ code: 40105, message: "Access token is incorrect or has been revoked." }));
    const e = await caught(tiktokRequest("GET", "advertiser/info/", { accessToken: "T" }));
    expect(e).toBeInstanceOf(TikTokApiError);
    expect(e.code).toBe(40105);
    expect(e.isAuthError).toBe(true);
  });

  it("el token va en la cabecera Access-Token; las listas, como JSON en la URL", async () => {
    const calls = stubTikTok(() => ok({ list: [] }));
    await tiktokRequest("GET", "advertiser/info/", { accessToken: "TT-SECRETO", query: { advertiser_ids: ["1", "2"], page: 3 } });
    expect((calls[0].init.headers as Record<string, string>)["Access-Token"]).toBe("TT-SECRETO");
    expect(calls[0].url.searchParams.get("advertiser_ids")).toBe('["1","2"]');
    expect(calls[0].url.searchParams.get("page")).toBe("3");
    expect(calls[0].url.toString()).not.toContain("TT-SECRETO");
  });

  it("una caida de red o una respuesta que no es JSON no filtran la URL", async () => {
    stubTikTok(() => new TypeError("fetch failed https://business-api.tiktok.com/x?access_token=SECRETO"));
    const net = await caught(tiktokRequest("GET", "x/"));
    expect(net.network).toBe(true);
    expect(JSON.stringify(net.message)).not.toContain("SECRETO");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    const bad = await caught(tiktokRequest("GET", "x/"));
    expect(bad).toBeInstanceOf(TikTokApiError);
    expect(bad.status).toBe(502);
  });

  it("clasifica los codigos de TikTok con mensajes en español", () => {
    const e = (code: number, message = "x", status = 200) => new TikTokApiError({ code, message, status });
    expect(e(40105, "Access token is incorrect or has been revoked.").userMessage).toMatch(/venció o fue revocada.*TikTok Ads/);
    expect(e(40104, "Access token is empty").isAuthError).toBe(true);
    expect(e(40100, "Too many requests").isRateLimit).toBe(true);
    expect(e(40100, "Too many requests").isAuthError).toBe(false);
    expect(e(40133).isRateLimit).toBe(true);
    expect(e(40100).userMessage).toMatch(/esperar/);
    expect(e(50000, "System error").isTemporary).toBe(true);
    expect(e(50000).userMessage).toMatch(/problema temporal/);
    expect(e(0, "boom", 503).isTemporary).toBe(true);
    expect(e(0, "x", 401).isAuthError).toBe(true);
    expect(e(40002, "Invalid metrics").isAuthError).toBe(false);
    expect(e(40002, "Invalid metrics").userMessage).toContain("(40002): Invalid metrics");
    expect(e(40002, "No permission for scope").userMessage).toMatch(/falta de permisos/);
  });
});

describe("anunciantes de TikTok", () => {
  it("pide los datos por lotes de 50 y avisa de los que TikTok no devolvio", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(7000 + i));
    const calls = stubTikTok((c) => {
      const asked: string[] = JSON.parse(c.url.searchParams.get("advertiser_ids") ?? "[]");
      return ok({ list: asked.filter((id) => id !== "7003").map((id) => ({ advertiser_id: id, name: `A ${id}`, currency: "USD", timezone: "America/Bogota" })) });
    });
    const r = await discoverAdvertisers("T", ids);
    expect(calls).toHaveLength(3);
    expect(r.accounts).toHaveLength(119);
    expect(r.skipped).toEqual([{ id: "7003", reason: expect.stringMatching(/no devolvió datos/) }]);
    expect(r.accounts[0]).toEqual({ id: "7000", name: "A 7000", currency: "USD", timezone: "America/Bogota" });
  });

  it("descarta ids raros y repetidos, y rellena el nombre si falta", async () => {
    stubTikTok(() => ok({ list: [{ advertiser_id: "7001", name: "  ", currency: "USD" }] }));
    const r = await discoverAdvertisers("T", ["7001", "7001", "no-numerico", "9".repeat(30)]);
    expect(r.accounts).toEqual([{ id: "7001", name: "Anunciante 7001", currency: "USD", timezone: null }]);
    expect(r.skipped).toEqual([]);
  });
});

describe("reporte de TikTok", () => {
  it("parte el periodo en tramos de 30 dias como maximo", () => {
    expect(dateChunks("2026-07-18", "2026-10-15")).toEqual([
      ["2026-07-18", "2026-08-16"],
      ["2026-08-17", "2026-09-15"],
      ["2026-09-16", "2026-10-15"],
    ]);
    expect(dateChunks("2026-10-01", "2026-10-30")).toEqual([["2026-10-01", "2026-10-30"]]);
    expect(dateChunks("2026-10-01", "2026-10-31")).toEqual([["2026-10-01", "2026-10-30"], ["2026-10-31", "2026-10-31"]]);
    expect(dateChunks("2026-10-05", "2026-10-05")).toEqual([["2026-10-05", "2026-10-05"]]);
    expect(dateChunks("2026-10-05", "2026-10-01")).toEqual([]);
  });

  it("normaliza una fila (fecha con hora, cifras como texto)", () => {
    expect(
      normalizeRow({
        dimensions: { campaign_id: "1801", stat_time_day: "2026-10-01 00:00:00" },
        metrics: { campaign_name: "Video marca", spend: "12.34", impressions: "1000", clicks: "10", reach: "800", conversion: "3" },
      }),
    ).toEqual({ date: "2026-10-01", campaignId: "1801", campaignName: "Video marca", spend: "12.34", impressions: 1000, clicks: 10, reach: 800, actions: { conversions: 3 } });
    expect(normalizeRow({ dimensions: { campaign_id: "1", stat_time_day: "2026-10-01 00:00:00" }, metrics: { spend: "no" } })).toMatchObject({ spend: "0", campaignName: "Campaña 1", actions: null });
    expect(normalizeRow({ dimensions: { campaign_id: "1", stat_time_day: "fecha" } })).toBeNull();
    expect(normalizeRow({ dimensions: { stat_time_day: "2026-10-01 00:00:00" } })).toBeNull();
  });

  it("pide cada tramo y recorre todas las paginas", async () => {
    const calls = stubTikTok((c) => {
      const page = Number(c.url.searchParams.get("page"));
      return ok({
        list: [{ dimensions: { campaign_id: "1", stat_time_day: `${c.url.searchParams.get("start_date")} 00:00:00` }, metrics: { spend: "1.00", impressions: "10", clicks: "1" } }],
        page_info: { page, total_page: 2 },
      });
    });
    const rows = await fetchCampaignInsights("7001", "T", "2026-07-18", "2026-10-15");
    expect(calls).toHaveLength(6); // 3 tramos x 2 paginas
    expect(rows).toHaveLength(6);
    const q = calls[0].url.searchParams;
    expect(q.get("advertiser_id")).toBe("7001");
    expect(q.get("data_level")).toBe("AUCTION_CAMPAIGN");
    expect(q.get("report_type")).toBe("BASIC");
    expect(JSON.parse(q.get("dimensions")!)).toEqual(["campaign_id", "stat_time_day"]);
    expect(JSON.parse(q.get("metrics")!)).toEqual(expect.arrayContaining(["campaign_name", "spend", "impressions", "clicks", "reach"]));
    for (const c of calls) {
      const span = (Date.parse(c.url.searchParams.get("end_date")!) - Date.parse(c.url.searchParams.get("start_date")!)) / 86_400_000 + 1;
      expect(span).toBeLessThanOrEqual(30);
    }
  });

  it("un ID de anunciante con caracteres raros se rechaza antes de pedir nada", async () => {
    const calls = stubTikTok(() => ok({ list: [] }));
    await expect(fetchCampaignInsights("7001&x=1", "T", "2026-10-01", "2026-10-02")).rejects.toThrow(/no valido/);
    expect(calls).toHaveLength(0);
  });

  it("un error de TikTok a mitad de camino se propaga (no se guarda nada a medias)", async () => {
    stubTikTok((_c, n) => (n === 1 ? ok({ list: [], page_info: { total_page: 1 } }) : { code: 40105, message: "Access token is incorrect or has been revoked." }));
    const e = await fetchCampaignInsights("7001", "T", "2026-07-18", "2026-10-15").catch((err) => err);
    expect(e).toBeInstanceOf(TikTokApiError);
    expect(e.isAuthError).toBe(true);
  });
});
