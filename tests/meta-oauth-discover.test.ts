import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAssets } from "@/lib/meta/discover";
import { fetchCampaignInsights, normalizeInsight } from "@/lib/meta/insights";
import { buildAuthorizeUrl, exchangeCode, toLongLivedToken } from "@/lib/meta/oauth";
import { META_SCOPES } from "@/lib/meta/config";
import { APP_ID, APP_SECRET, setMetaEnv, stubFetch } from "./helpers/meta-env";

beforeEach(() => setMetaEnv());
afterEach(() => vi.unstubAllGlobals());

describe("OAuth", () => {
  it("arma la URL del cuadro de permisos de Facebook", () => {
    const url = new URL(buildAuthorizeUrl("ESTADO-1"));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/meta/callback");
    expect(url.searchParams.get("state")).toBe("ESTADO-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("auth_type")).toBe("rerequest");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([...META_SCOPES]);
    // El secreto de la app jamas va en la URL que ve el navegador.
    expect(url.toString()).not.toContain(APP_SECRET);
  });

  it("con Facebook Login for Business usa config_id en lugar de la lista de permisos", async () => {
    vi.resetModules();
    setMetaEnv({ META_LOGIN_CONFIG_ID: "987654321" });
    const mod = await import("@/lib/meta/oauth");
    const url = new URL(mod.buildAuthorizeUrl("ESTADO-2"));
    expect(url.searchParams.get("config_id")).toBe("987654321");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("ESTADO-2");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("META_SCOPES limita los permisos que se piden (para apps de Meta que no incluyen todos)", async () => {
    vi.resetModules();
    setMetaEnv({ META_SCOPES: " ads_read , pages_show_list,pages_read_engagement " });
    const mod = await import("@/lib/meta/oauth");
    const url = new URL(mod.buildAuthorizeUrl("E"));
    expect(url.searchParams.get("scope")).toBe("ads_read,pages_show_list,pages_read_engagement");
    expect(url.searchParams.get("scope")).not.toContain("instagram");
  });

  it("META_SCOPES con un formato raro se rechaza (no se mete texto libre en la URL)", async () => {
    for (const bad of ["ads_read pages_show_list", "ads_read;drop", "ADS_READ", "ads_read,,"]) {
      vi.resetModules();
      setMetaEnv({ META_SCOPES: bad });
      const { env: fresh } = await import("@/lib/env");
      expect(() => fresh(), bad).toThrow(/META_SCOPES/);
    }
  });

  it("rechaza un META_LOGIN_CONFIG_ID que no sea numerico", async () => {
    vi.resetModules();
    setMetaEnv({ META_LOGIN_CONFIG_ID: "abc" });
    const { env: fresh } = await import("@/lib/env");
    expect(() => fresh()).toThrow(/META_LOGIN_CONFIG_ID/);
  });

  it("pide los permisos de anuncios, paginas e Instagram", () => {
    for (const s of ["ads_read", "pages_show_list", "pages_manage_posts", "instagram_content_publish"]) {
      expect(META_SCOPES).toContain(s);
    }
  });

  it("cambia el codigo por un token (llamada de servidor con el secreto)", async () => {
    const calls = stubFetch(() => ({ body: { access_token: "CORTO" } }));
    expect(await exchangeCode("CODIGO-9")).toBe("CORTO");
    const p = calls[0].url.searchParams;
    expect(calls[0].url.pathname).toBe("/v26.0/oauth/access_token");
    expect(p.get("code")).toBe("CODIGO-9");
    expect(p.get("client_secret")).toBe(APP_SECRET);
    expect(p.get("redirect_uri")).toBe("http://localhost:3000/api/meta/callback");
  });

  it("cambia el token corto por uno de larga duracion y calcula cuando vence", async () => {
    const calls = stubFetch(() => ({ body: { access_token: "LARGO", expires_in: 5_184_000 } }));
    const before = Date.now();
    const tok = await toLongLivedToken("CORTO");
    expect(tok.accessToken).toBe("LARGO");
    expect(calls[0].url.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(calls[0].url.searchParams.get("fb_exchange_token")).toBe("CORTO");
    const days = (tok.expiresAt!.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });

  it("si Meta no informa la duracion, expiresAt es null", async () => {
    stubFetch(() => ({ body: { access_token: "LARGO" } }));
    expect((await toLongLivedToken("x")).expiresAt).toBeNull();
  });

  it("falla si Meta no devuelve token", async () => {
    stubFetch(() => ({ body: {} }));
    await expect(exchangeCode("c")).rejects.toThrow(/token/);
  });
});

describe("discoverAssets", () => {
  const route = (overrides: Record<string, () => { body: unknown; status?: number }> = {}) =>
    stubFetch((url) => {
      const key = url.pathname.replace("/v26.0/", "");
      if (overrides[key]) return overrides[key]();
      if (key === "me") return { body: { id: "U1", name: "Mario" } };
      if (key === "me/permissions") {
        return {
          body: {
            data: [
              { permission: "ads_read", status: "granted" },
              { permission: "pages_show_list", status: "granted" },
              { permission: "instagram_content_publish", status: "declined" },
            ],
          },
        };
      }
      if (key === "me/adaccounts") {
        return {
          body: { data: [{ account_id: "555", name: "Mi tienda", currency: "COP", timezone_name: "America/Bogota", account_status: 1 }] },
        };
      }
      if (key === "me/accounts") {
        return {
          body: {
            data: [
              { id: "P1", name: "Mi página", access_token: "PAGE-TOKEN", instagram_business_account: { id: "IG1", username: "mitienda" } },
              { id: "P2", name: "Sin Instagram", access_token: "PAGE-TOKEN-2" },
            ],
          },
        };
      }
      return { status: 404, body: { error: { message: "no", code: 803 } } };
    });

  it("reune permisos, cuentas publicitarias, paginas e Instagram vinculado", async () => {
    route();
    const a = await discoverAssets("USER-TOKEN");
    expect(a.user).toEqual({ id: "U1", name: "Mario" });
    expect(a.grantedScopes).toEqual(["ads_read", "pages_show_list"]);
    expect(a.declinedScopes).toEqual(["instagram_content_publish"]);
    expect(a.adAccounts).toEqual([
      { id: "555", name: "Mi tienda", currency: "COP", timezone: "America/Bogota", accountStatus: 1 },
    ]);
    expect(a.pages).toHaveLength(2);
    expect(a.pages[0]).toMatchObject({
      id: "P1",
      accessToken: "PAGE-TOKEN",
      instagram: { id: "IG1", username: "mitienda", name: null },
    });
    expect(a.pages[1].instagram).toBeNull();
  });

  it("si falta ads_read, las cuentas publicitarias quedan vacias pero la conexion sigue", async () => {
    route({ "me/adaccounts": () => ({ status: 403, body: { error: { message: "Requires ads_read", code: 200 } } }) });
    const a = await discoverAssets("T");
    expect(a.adAccounts).toEqual([]);
    expect(a.pages).toHaveLength(2);
  });

  it("si el campo de Instagram falla por permisos, reintenta solo con las paginas", async () => {
    let tries = 0;
    const calls = route({
      "me/accounts": () => {
        tries++;
        return tries === 1
          ? { status: 400, body: { error: { message: "(#10) instagram_basic", code: 10 } } }
          : { body: { data: [{ id: "P1", name: "Mi página", access_token: "PT" }] } };
      },
    });
    const a = await discoverAssets("T");
    expect(a.pages).toHaveLength(1);
    expect(a.pages[0].instagram).toBeNull();
    const accountCalls = calls.filter((c) => c.url.pathname.endsWith("me/accounts"));
    expect(accountCalls[0].url.searchParams.get("fields")).toContain("instagram_business_account");
    expect(accountCalls[1].url.searchParams.get("fields")).not.toContain("instagram_business_account");
  });

  it("un token vencido (190) corta toda la conexion", async () => {
    route({ me: () => ({ status: 400, body: { error: { message: "expired", code: 190 } } }) });
    await expect(discoverAssets("T")).rejects.toMatchObject({ code: 190 });
  });
});

describe("insights", () => {
  it("convierte las cifras de texto a numeros y las acciones a un objeto", () => {
    expect(
      normalizeInsight({
        campaign_id: "C1",
        campaign_name: "Black Friday",
        date_start: "2026-10-10",
        spend: "12.3456",
        impressions: "1000",
        clicks: "25",
        reach: "800",
        actions: [
          { action_type: "link_click", value: "20" },
          { action_type: "purchase", value: "3" },
          { action_type: "roto", value: "no-es-numero" },
        ],
      }),
    ).toEqual({
      date: "2026-10-10",
      campaignId: "C1",
      campaignName: "Black Friday",
      spend: "12.3456",
      impressions: 1000,
      clicks: 25,
      reach: 800,
      actions: { link_click: 20, purchase: 3 },
    });
  });

  it("tolera campos ausentes o invalidos", () => {
    const row = normalizeInsight({ campaign_id: "C2", date_start: "2026-10-11", spend: "abc", clicks: "-5" });
    expect(row).toMatchObject({ campaignName: "Campaña C2", spend: "0", impressions: 0, clicks: 0, reach: 0, actions: null });
  });

  it("descarta filas sin campaña o con fecha invalida", () => {
    expect(normalizeInsight({ date_start: "2026-10-10" })).toBeNull();
    expect(normalizeInsight({ campaign_id: "C", date_start: "10/10/2026" })).toBeNull();
  });

  it("pide el rendimiento diario por campaña de la cuenta (act_<id>) en el rango dado", async () => {
    const calls = stubFetch(() => ({
      body: { data: [{ campaign_id: "C1", date_start: "2026-10-01", spend: "1.5" }, { date_start: "2026-10-02" }] },
    }));
    const rows = await fetchCampaignInsights("555", "TOK", "2026-10-01", "2026-10-07");
    expect(rows).toHaveLength(1); // la fila sin campaña se descarta
    const { url } = calls[0];
    expect(url.pathname).toBe("/v26.0/act_555/insights");
    expect(url.searchParams.get("level")).toBe("campaign");
    expect(url.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(url.searchParams.get("time_range")!)).toEqual({ since: "2026-10-01", until: "2026-10-07" });
  });
});
