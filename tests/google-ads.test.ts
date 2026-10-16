import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchStream } from "@/lib/google/client";
import { discoverCustomers } from "@/lib/google/discover";
import { GoogleApiError } from "@/lib/google/errors";
import { fetchCampaignInsights, microsToDecimal, normalizeInsight } from "@/lib/google/insights";
import { buildAuthorizeUrl, emailFromIdToken, exchangeCode, refreshAccessToken } from "@/lib/google/oauth";
import { setMetaEnv } from "./helpers/meta-env";

const CLIENT_ID = "123456789012-pruebas.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-secreto-de-prueba";

beforeEach(() => {
  setMetaEnv({
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_ADS_API_VERSION: undefined,
    GOOGLE_ADS_DEVELOPER_TOKEN: undefined,
    GOOGLE_OAUTH_BASE_URL: undefined,
    GOOGLE_ADS_API_BASE_URL: undefined,
  });
});
afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; init: RequestInit };
/** Sustituye fetch por respuestas en cola (la ultima se repite) y anota cada llamada. */
function stubFetch(...responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));
const headersOf = (c: Call) => c.init.headers as Record<string, string>;

describe("OAuth de Google", () => {
  it("el cuadro de permisos pide solo lo necesario y lo que hace falta para recibir el token de renovacion", () => {
    const url = new URL(buildAuthorizeUrl("estado-123"));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe("http://localhost:3000/api/google/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("https://www.googleapis.com/auth/adwords openid email");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("state")).toBe("estado-123");
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it("cambia el codigo por los tokens (secreto en el cuerpo, no en la URL) y lee el correo del id_token", async () => {
    const idToken = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ email: "mario@example.com" })).toString("base64url")}.firma`;
    const calls = stubFetch({
      body: { access_token: "ya29.A", refresh_token: "1//R", expires_in: 3599, scope: "https://www.googleapis.com/auth/adwords openid email", id_token: idToken },
    });
    const t = await exchangeCode("4/codigo");
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("4/codigo");
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(calls[0].url).not.toContain(CLIENT_SECRET);
    expect(t).toMatchObject({ accessToken: "ya29.A", refreshToken: "1//R", scopes: ["https://www.googleapis.com/auth/adwords", "openid", "email"], email: "mario@example.com" });
    expect(t.expiresAt.getTime() - Date.now()).toBeGreaterThan(3500_000);
  });

  it("si Google no devuelve token de renovacion, lo dice (queda null)", async () => {
    stubFetch({ body: { access_token: "ya29.A", expires_in: 3599 } });
    expect((await exchangeCode("x")).refreshToken).toBeNull();
  });

  it("renueva el token de acceso con el de renovacion", async () => {
    const calls = stubFetch({ body: { access_token: "ya29.NUEVO", expires_in: 3599 } });
    const r = await refreshAccessToken("1//R");
    expect(new URLSearchParams(String(calls[0].init.body)).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(String(calls[0].init.body)).get("refresh_token")).toBe("1//R");
    expect(r.accessToken).toBe("ya29.NUEVO");
  });

  it("invalid_grant al renovar es una conexion vencida; invalid_client, un problema de configuracion", async () => {
    stubFetch({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    const grant = await refreshAccessToken("1//R").catch((e) => e);
    expect(grant).toBeInstanceOf(GoogleApiError);
    expect(grant.isAuthError).toBe(true);
    expect(grant.userMessage).toMatch(/venció o fue revocada.*Google Ads/);

    stubFetch({ status: 401, body: { error: "invalid_client" } });
    const client = await refreshAccessToken("1//R").catch((e) => e);
    expect(client.isBadClient).toBe(true);
    expect(client.userMessage).toMatch(/GOOGLE_CLIENT_ID/);
    // Aunque llega como 401, NO es una conexion vencida: marcar las cuentas como vencidas no lo arreglaria.
    expect(client.isAuthError).toBe(false);
  });

  it("una caida de red no filtra la URL ni el secreto", async () => {
    stubFetch(new TypeError(`fetch failed https://oauth2.googleapis.com/token ${CLIENT_SECRET}`));
    const e = await exchangeCode("x").catch((err) => err);
    expect(e.network).toBe(true);
    expect(JSON.stringify(e.message)).not.toContain(CLIENT_SECRET);
    expect(e.userMessage).toMatch(/No se pudo contactar a Google/);
  });

  it("emailFromIdToken tolera tokens raros", () => {
    expect(emailFromIdToken(undefined)).toBeNull();
    expect(emailFromIdToken("no-es-un-jwt")).toBeNull();
    expect(emailFromIdToken("a.!!!.c")).toBeNull();
  });
});

describe("errores de la API de Google Ads", () => {
  const ads = (status: number, googleStatus: string, category: string, value: string, message = "x") =>
    GoogleApiError.fromAdsResponse(status, { error: { code: status, message: "generico", status: googleStatus, details: [{ errors: [{ errorCode: { [category]: value }, message }] }] } });

  it("lee la categoria y el valor del error de Google Ads", () => {
    const e = ads(403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED", "sin permiso");
    expect(e).toMatchObject({ status: 403, googleStatus: "PERMISSION_DENIED", adsCategory: "authorizationError", adsValue: "USER_PERMISSION_DENIED", message: "sin permiso" });
  });

  it("clasifica cada caso con un mensaje en español", () => {
    expect(ads(401, "UNAUTHENTICATED", "authenticationError", "OAUTH_TOKEN_INVALID").isAuthError).toBe(true);
    expect(ads(401, "UNAUTHENTICATED", "authenticationError", "OAUTH_TOKEN_INVALID").userMessage).toMatch(/Vuelve a conectar Google Ads/);
    expect(ads(403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED").userMessage).toMatch(/no tiene acceso a esta cuenta/);
    expect(ads(403, "PERMISSION_DENIED", "authorizationError", "CUSTOMER_NOT_ENABLED").userMessage).toMatch(/cancelada o inactiva/);
    expect(ads(403, "PERMISSION_DENIED", "authorizationError", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION").userMessage).toMatch(/Explorer o Básico/);
    expect(ads(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED").userMessage).toMatch(/esperar/);
    expect(ads(500, "INTERNAL", "internalError", "INTERNAL_ERROR").userMessage).toMatch(/problema temporal/);
  });

  it("una cuenta sin permiso o un limite de uso NO vencen la conexion", () => {
    expect(ads(403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED").isAuthError).toBe(false);
    expect(ads(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED").isAuthError).toBe(false);
    expect(ads(403, "PERMISSION_DENIED", "authorizationError", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION").isAuthError).toBe(false);
  });

  it("un cuerpo sin forma conocida da un mensaje generico y corto", () => {
    const e = GoogleApiError.fromAdsResponse(418, null);
    expect(e.userMessage).toMatch(/Google devolvió un error/);
    expect(GoogleApiError.fromAdsResponse(400, { error: { message: "x".repeat(500) } }).userMessage.length).toBeLessThan(260);
  });
});

describe("cliente de la API de Google Ads", () => {
  it("envia el token como Bearer, login-customer-id si hay y el developer token solo si esta configurado", async () => {
    const calls = stubFetch({ body: [{ results: [{ a: 1 }] }, { results: [{ a: 2 }] }] });
    const rows = await searchStream("1234567890", "SELECT 1", { accessToken: "ya29.A", loginCustomerId: "2222222222" });
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]); // los lotes se aplanan
    expect(calls[0].url).toBe("https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream");
    expect(headersOf(calls[0])).toMatchObject({ authorization: "Bearer ya29.A", "login-customer-id": "2222222222" });
    expect(headersOf(calls[0])).not.toHaveProperty("developer-token");
    expect(bodyOf(calls[0])).toEqual({ query: "SELECT 1" });
    expect(calls[0].url).not.toContain("ya29");

    setMetaEnv({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN: "token-de-desarrollador" });
    // env() guarda su valor: se comprueba con el modulo recargado.
    vi.resetModules();
    const fresh = await import("@/lib/google/client");
    const calls2 = stubFetch({ body: [{ results: [] }] });
    await fresh.searchStream("1234567890", "SELECT 1", { accessToken: "ya29.A" });
    expect(headersOf(calls2[0])["developer-token"]).toBe("token-de-desarrollador");
    expect(headersOf(calls2[0])).not.toHaveProperty("login-customer-id");
  });

  it("rechaza IDs de cliente con caracteres raros antes de armar la URL", async () => {
    stubFetch({ body: [] });
    await expect(searchStream("123/../x", "q", { accessToken: "a" })).rejects.toThrow(/no valido/);
    await expect(searchStream("123", "q", { accessToken: "a", loginCustomerId: "1;2" })).rejects.toThrow();
  });

  it("acepta tambien una respuesta que no viene en lotes", async () => {
    stubFetch({ body: { results: [{ a: 1 }] } });
    expect(await searchStream("1", "q", { accessToken: "a" })).toEqual([{ a: 1 }]);
  });

  it("un error de la API se convierte en GoogleApiError sin filtrar el token", async () => {
    stubFetch({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED", message: "invalid" } } });
    const e = await searchStream("1", "q", { accessToken: "ya29.SECRETO" }).catch((err) => err);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e.isAuthError).toBe(true);
    expect(JSON.stringify(e)).not.toContain("ya29.SECRETO");
  });
});

describe("metricas de Google Ads", () => {
  it("convierte micros a decimal sin pasar por coma flotante", () => {
    expect(microsToDecimal("12345678")).toBe("12.345678");
    expect(microsToDecimal("1")).toBe("0.000001");
    expect(microsToDecimal("2000000")).toBe("2.000000");
    expect(microsToDecimal("170000000000")).toBe("170000.000000");
    expect(microsToDecimal(undefined)).toBe("0.000000".replace(/^0\.0+$/, "0.000000"));
    expect(microsToDecimal("abc")).toBe("0");
    expect(microsToDecimal(3500000)).toBe("3.500000");
  });

  it("normaliza una fila (enteros como texto, conversiones como numero)", () => {
    expect(
      normalizeInsight({ campaign: { id: "7001", name: "Búsqueda marca" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "3234567", impressions: "900", clicks: "30", conversions: 2.5 } }),
    ).toEqual({ date: "2026-10-01", campaignId: "7001", campaignName: "Búsqueda marca", spend: "3.234567", impressions: 900, clicks: 30, reach: 0, actions: { conversions: 2.5 } });
  });

  it("sin conversiones no hay acciones; sin nombre se usa el id; sin id o fecha se descarta", () => {
    const base = { campaign: { id: "9" }, segments: { date: "2026-10-01" }, metrics: { costMicros: "0", impressions: "0", clicks: "0", conversions: 0 } };
    expect(normalizeInsight(base)).toMatchObject({ campaignName: "Campaña 9", actions: null, spend: "0.000000" });
    expect(normalizeInsight({ ...base, campaign: {} })).toBeNull();
    expect(normalizeInsight({ ...base, segments: { date: "01/10/2026" } })).toBeNull();
    expect(normalizeInsight({ campaign: { id: "9" } })).toBeNull();
  });

  it("pide la consulta por dia y campaña con las fechas validadas", async () => {
    const calls = stubFetch({ body: [{ results: [{ campaign: { id: "1", name: "A" }, segments: { date: "2026-10-02" }, metrics: { costMicros: "1000000", impressions: "5", clicks: "1" } }] }] });
    const rows = await fetchCampaignInsights("1111111111", { accessToken: "a" }, "2026-10-01", "2026-10-31");
    expect(bodyOf(calls[0]).query).toContain("segments.date BETWEEN '2026-10-01' AND '2026-10-31'");
    expect(bodyOf(calls[0]).query).toContain("FROM campaign");
    expect(rows).toHaveLength(1);
    await expect(fetchCampaignInsights("1", { accessToken: "a" }, "2026-10-01' OR 1=1 --", "2026-10-31")).rejects.toThrow(/Fechas/);
  });
});

describe("descubrir cuentas de Google Ads", () => {
  /** Servidor falso: segun la consulta devuelve la cuenta, sus clientes o la lista de accesibles. */
  function fakeAds(opts: { accessible: string[]; customers: Record<string, { manager?: boolean; status?: string; fail?: GoogleApiError | number }>; children?: string[] }) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
        if (url.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: opts.accessible.map((i) => `customers/${i}`) });
        const id = url.match(/customers\/(\d+)\/googleAds:searchStream/)![1];
        const c = opts.customers[id] ?? {};
        if (typeof c.fail === "number") return json({ error: { code: c.fail, status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "CUSTOMER_NOT_ENABLED" } }] }] } }, c.fail);
        const query = JSON.parse(String(init.body)).query as string;
        if (/FROM customer_client/.test(query)) {
          return json([{ results: [id, ...(opts.children ?? [])].map((cid) => ({ customerClient: { id: cid, descriptiveName: `Cuenta ${cid}`, currencyCode: "USD", timeZone: "America/Bogota", manager: cid === id, status: "ENABLED" } })) }]);
        }
        return json([{ results: [{ customer: { id, descriptiveName: `Cuenta ${id}`, currencyCode: "USD", timeZone: "America/Bogota", manager: !!c.manager, status: c.status ?? "ENABLED" } }] }]);
      }),
    );
    return calls;
  }

  it("lista las cuentas directas y, de una administradora, sus clientes (sin guardar la administradora)", async () => {
    const calls = fakeAds({ accessible: ["1", "2"], customers: { "1": {}, "2": { manager: true } }, children: ["3", "4"] });
    const r = await discoverCustomers("ya29.A");
    expect(r.accounts.map((a) => [a.id, a.loginCustomerId])).toEqual(expect.arrayContaining([["1", null], ["3", "2"], ["4", "2"]]));
    expect(r.accounts.map((a) => a.id)).not.toContain("2");
    expect(r.accounts).toHaveLength(3);
    // Los clientes de la administradora se piden a traves de ella.
    const childCall = calls.find((c) => /customer_client/.test(String(c.init.body)))!;
    expect(headersOf(childCall)["login-customer-id"]).toBe("2");
  });

  it("si una cuenta es directa y tambien cuelga de una administradora, manda el acceso directo", async () => {
    fakeAds({ accessible: ["1", "2"], customers: { "1": {}, "2": { manager: true } }, children: ["1", "3"] });
    const r = await discoverCustomers("ya29.A");
    expect(r.accounts.find((a) => a.id === "1")?.loginCustomerId).toBeNull();
  });

  it("una cuenta cancelada o que no se puede leer se salta sin tumbar las demas", async () => {
    fakeAds({ accessible: ["1", "5", "6"], customers: { "1": {}, "5": { status: "CANCELED" }, "6": { fail: 403 } } });
    const r = await discoverCustomers("ya29.A");
    expect(r.accounts.map((a) => a.id)).toEqual(["1"]);
    expect(r.skipped.map((s) => s.id)).toEqual(["6"]); // la cancelada simplemente no se guarda; la ilegible se informa
    expect(r.skipped[0].reason).toMatch(/cancelada o inactiva/);
  });

  it("un token vencido o un proyecto sin acceso a la API se propagan (afectan a todas)", async () => {
    stubFetch({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } });
    await expect(discoverCustomers("ya29.A")).rejects.toMatchObject({ isAuthError: true });
    stubFetch({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" } }] }] } } });
    await expect(discoverCustomers("ya29.A")).rejects.toMatchObject({ isProjectNotApproved: true });
  });
});
