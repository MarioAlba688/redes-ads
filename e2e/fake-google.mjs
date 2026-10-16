// Servidor que imita a Google (cuadro de permisos OAuth, token y API de Google Ads) para las pruebas, sin cuentas reales.
// Valida lo que valida Google: client_id/secret, redirect_uri, token de renovacion, token de acceso (Bearer) y la
// cabecera login-customer-id al consultar cuentas que cuelgan de una administradora (MCC).

import http from "node:http";

export const CLIENT_ID = "123456789012-pruebasredes.apps.googleusercontent.com";
export const CLIENT_SECRET = "GOCSPX-secreto-de-prueba-de-google";
export const GOOD_CODE = "4/0GOOD-CODE-GOOGLE";
export const REFRESH_TOKEN = "1//0gREFRESH-TOKEN-DE-PRUEBA-AAAAAAAA";
export const EMAIL = "mario@example.com";
export const VERSION = "v25";

// Cuentas: 1111 directa; 2222 administradora (MCC) con 3333, 4444 (y 1111, repetida) como clientes; 5555 cancelada.
export const CUSTOMERS = {
  "1111111111": { name: "Tienda Google", currency: "USD", tz: "America/Bogota", manager: false, status: "ENABLED", factor: 1 },
  "2222222222": { name: "Agencia MCC", currency: "USD", tz: "America/Bogota", manager: true, status: "ENABLED", factor: 1 },
  "3333333333": { name: "Cliente A (MCC)", currency: "EUR", tz: "Europe/Madrid", manager: false, status: "ENABLED", factor: 1 },
  "4444444444": { name: "Cliente B (MCC)", currency: "COP", tz: "America/Bogota", manager: false, status: "ENABLED", factor: 4000 },
  "5555555555": { name: "Cuenta cancelada", currency: "USD", tz: "America/Bogota", manager: false, status: "CANCELED", factor: 1 },
};
const ACCESSIBLE = ["1111111111", "2222222222", "5555555555"];
const MCC_CHILDREN = ["1111111111", "3333333333", "4444444444"];
export const MCC_ID = "2222222222";
export const CAMPAIGNS = [
  { id: "7001", name: "Búsqueda marca" },
  { id: "7002", name: "Display remarketing" },
];

const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Cifras deterministas de una campaña un dia: la prueba calcula lo mismo para comparar. */
export function googleInsight(customerId, date, idx) {
  const factor = CUSTOMERS[customerId].factor;
  const seed = (dayNumber(date) + idx * 5 + Number(customerId.slice(-2))) % 11;
  return {
    impressions: 500 + seed * 100 + idx * 250,
    clicks: 20 + seed * 3 + idx * 7,
    // Micros (millonesimas de la moneda), como los manda Google.
    costMicros: (2_000_000 + seed * 1_234_567 + idx * 3_210_000) * factor,
    conversions: seed % 3 === 0 ? 2.5 : 0,
  };
}

const DEFAULT_SCENARIO = {
  dialog: "approve", // approve | deny | badstate
  refreshToken: "give", // give | omit (el token de renovacion no viene en la respuesta)
  tokenEndpoint: "ok", // ok | invalid_client
  refresh: "ok", // ok | revoked (invalid_grant al renovar)
  accessTokens: "valid", // valid | expired (la API responde 401 UNAUTHENTICATED)
  accessible: "ok", // ok | notapproved (403 CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION) | empty
  fail: {}, // { "1111111111": "ratelimit" | "server" | "permission" } error al pedir metricas de esa cuenta
};

export function startFakeGoogle(port, expectedRedirectUri) {
  let scenario = { ...DEFAULT_SCENARIO };
  let requests = [];
  let lastDialog = null;
  let issued = 0;
  let refreshCalls = 0;
  const validAccess = new Set();

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const oauthError = (res, status, error, description) => json(res, status, { error, error_description: description });
  const adsError = (res, status, googleStatus, category, value, message) =>
    json(res, status, {
      error: {
        code: status,
        message,
        status: googleStatus,
        details: [{ "@type": `type.googleapis.com/google.ads.googleads.${VERSION}.errors.GoogleAdsFailure`, errors: [{ errorCode: { [category]: value }, message }] }],
      },
    });

  const newAccessToken = () => {
    const token = `ya29.ACCESS-TOKEN-${++issued}`;
    validAccess.add(token);
    return token;
  };
  const idToken = () => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ email: EMAIL, sub: "1234" })).toString("base64url")}.firma`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.searchParams;
    let raw = "";
    for await (const chunk of req) raw += chunk;

    // --- control de la prueba ---
    if (url.pathname === "/__scenario" && req.method === "POST") {
      scenario = { ...scenario, ...JSON.parse(raw || "{}") };
      return json(res, 200, scenario);
    }
    if (url.pathname === "/__reset") {
      scenario = { ...DEFAULT_SCENARIO };
      requests = [];
      lastDialog = null;
      refreshCalls = 0;
      return json(res, 200, {});
    }
    if (url.pathname === "/__requests") return json(res, 200, { requests, lastDialog, refreshCalls });

    // --- cuadro de permisos de Google (navegador) ---
    if (url.pathname === "/o/oauth2/v2/auth") {
      lastDialog = Object.fromEntries(p);
      requests.push({ path: "auth" });
      if (p.get("client_id") !== CLIENT_ID) return json(res, 400, { error: "invalid_client" });
      if (p.get("redirect_uri") !== expectedRedirectUri) return json(res, 400, { error: "redirect_uri_mismatch" });
      const back = new URL(p.get("redirect_uri"));
      if (scenario.dialog === "deny") back.search = new URLSearchParams({ error: "access_denied", state: p.get("state") }).toString();
      else back.search = new URLSearchParams({ code: GOOD_CODE, state: scenario.dialog === "badstate" ? "estado-falso" : p.get("state") }).toString();
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // --- token (servidor a servidor) ---
    if (url.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(raw);
      requests.push({ path: "token", grant: f.get("grant_type") });
      if (scenario.tokenEndpoint === "invalid_client" || f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET) {
        return oauthError(res, 401, "invalid_client", "The OAuth client was not found.");
      }
      if (f.get("grant_type") === "authorization_code") {
        if (f.get("code") !== GOOD_CODE) return oauthError(res, 400, "invalid_grant", "Malformed auth code.");
        if (f.get("redirect_uri") !== expectedRedirectUri) return oauthError(res, 400, "redirect_uri_mismatch", "Bad Request");
        return json(res, 200, {
          access_token: newAccessToken(),
          expires_in: 3599,
          ...(scenario.refreshToken === "give" ? { refresh_token: REFRESH_TOKEN } : {}),
          scope: "https://www.googleapis.com/auth/adwords openid https://www.googleapis.com/auth/userinfo.email",
          token_type: "Bearer",
          id_token: idToken(),
        });
      }
      if (f.get("grant_type") === "refresh_token") {
        refreshCalls++;
        if (scenario.refresh === "revoked" || f.get("refresh_token") !== REFRESH_TOKEN) {
          return oauthError(res, 400, "invalid_grant", "Token has been expired or revoked.");
        }
        return json(res, 200, { access_token: newAccessToken(), expires_in: 3599, scope: "https://www.googleapis.com/auth/adwords", token_type: "Bearer" });
      }
      return oauthError(res, 400, "unsupported_grant_type", "Bad Request");
    }

    // --- API de Google Ads ---
    const m = url.pathname.match(new RegExp(`^/${VERSION}/(.+)$`));
    if (!m) return json(res, 404, { error: { code: 404, message: `Ruta no soportada: ${url.pathname}`, status: "NOT_FOUND" } });
    const path = m[1];
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const loginCustomerId = req.headers["login-customer-id"] ?? null;
    const body = raw ? JSON.parse(raw) : {};
    const entry = { path, method: req.method, token: bearer, loginCustomerId, developerToken: req.headers["developer-token"] ?? null, query: body.query ?? null };
    requests.push(entry);

    if (scenario.accessTokens === "expired" || !validAccess.has(bearer)) {
      return adsError(res, 401, "UNAUTHENTICATED", "authenticationError", "OAUTH_TOKEN_INVALID", "Request had invalid authentication credentials.");
    }

    if (path === "customers:listAccessibleCustomers") {
      if (scenario.accessible === "notapproved") {
        return adsError(res, 403, "PERMISSION_DENIED", "authorizationError", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", "The Cloud project is not approved for production access.");
      }
      return json(res, 200, { resourceNames: scenario.accessible === "empty" ? [] : ACCESSIBLE.map((id) => `customers/${id}`) });
    }

    const search = path.match(/^customers\/(\d+)\/googleAds:searchStream$/);
    if (search && req.method === "POST") {
      const id = search[1];
      const customer = CUSTOMERS[id];
      if (!customer) return adsError(res, 403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED", "User doesn't have permission to access customer.");
      const viaManager = MCC_CHILDREN.includes(id) && id !== "1111111111";
      // Las cuentas cliente de una MCC solo se consultan a traves de ella (excepto 1111, que tambien es de acceso directo).
      if (viaManager && loginCustomerId !== MCC_ID) {
        return adsError(res, 403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED", "User doesn't have permission to access customer. Note: If you're accessing a client customer, the manager's customer id must be set in the 'login-customer-id' header.");
      }
      if (customer.status === "CANCELED") {
        return adsError(res, 403, "PERMISSION_DENIED", "authorizationError", "CUSTOMER_NOT_ENABLED", "The customer account can't be accessed because it is not yet enabled or has been deactivated.");
      }
      const query = String(body.query ?? "");
      const batches = (rows) => {
        const out = [];
        for (let i = 0; i < Math.max(rows.length, 1); i += 100) out.push({ results: rows.slice(i, i + 100), fieldMask: "x", requestId: `req-${i}` });
        return out;
      };

      if (/FROM customer_client/.test(query)) {
        if (!customer.manager) return adsError(res, 400, "INVALID_ARGUMENT", "queryError", "PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE", "customer_client is only for manager accounts.");
        const rows = [id, ...MCC_CHILDREN].map((cid) => ({ customerClient: { id: cid, descriptiveName: CUSTOMERS[cid].name, currencyCode: CUSTOMERS[cid].currency, timeZone: CUSTOMERS[cid].tz, manager: CUSTOMERS[cid].manager, status: CUSTOMERS[cid].status } }));
        return json(res, 200, batches(rows));
      }
      if (/FROM customer LIMIT/.test(query)) {
        return json(res, 200, batches([{ customer: { id, descriptiveName: customer.name, currencyCode: customer.currency, timeZone: customer.tz, manager: customer.manager, status: customer.status } }]));
      }
      if (/FROM campaign/.test(query)) {
        const failure = scenario.fail[id];
        if (failure === "ratelimit") return adsError(res, 429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED", "Too many requests. Retry in 30 seconds.");
        if (failure === "server") return adsError(res, 500, "INTERNAL", "internalError", "INTERNAL_ERROR", "Internal error encountered.");
        if (failure === "permission") return adsError(res, 403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED", "User doesn't have permission to access customer.");
        const range = query.match(/BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/);
        if (!range) return adsError(res, 400, "INVALID_ARGUMENT", "queryError", "BAD_RESOURCE_TYPE_IN_FROM_CLAUSE", "Falta el rango de fechas.");
        const rows = [];
        for (let t = Date.parse(`${range[1]}T00:00:00Z`); t <= Date.parse(`${range[2]}T00:00:00Z`); t += 86_400_000) {
          const date = new Date(t).toISOString().slice(0, 10);
          CAMPAIGNS.forEach((c, ci) => {
            const v = googleInsight(id, date, ci);
            rows.push({
              campaign: { resourceName: `customers/${id}/campaigns/${c.id}`, id: c.id, name: c.name },
              metrics: { costMicros: String(v.costMicros), impressions: String(v.impressions), clicks: String(v.clicks), conversions: v.conversions },
              segments: { date },
            });
          });
        }
        return json(res, 200, batches(rows));
      }
      return adsError(res, 400, "INVALID_ARGUMENT", "queryError", "UNEXPECTED_END_OF_QUERY", "Consulta no soportada por el servidor de pruebas.");
    }
    return json(res, 404, { error: { code: 404, message: `Ruta no soportada: ${path}`, status: "NOT_FOUND" } });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        close: () => new Promise((r) => server.close(() => r())),
        setScenario: (s) => {
          scenario = { ...scenario, ...s };
        },
        reset: () => {
          scenario = { ...DEFAULT_SCENARIO };
          requests = [];
          lastDialog = null;
          refreshCalls = 0;
        },
        requests: () => requests,
        lastDialog: () => lastDialog,
        refreshCalls: () => refreshCalls,
        /** Invalida todos los tokens de acceso emitidos (como si Google los revocara). */
        revokeAccessTokens: () => validAccess.clear(),
      }),
    );
  });
}
