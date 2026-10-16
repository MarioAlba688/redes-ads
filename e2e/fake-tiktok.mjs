// Servidor que imita a la Marketing API de TikTok (v1.3) para las pruebas, sin cuentas reales.
// Replica lo que importa: TikTok responde HTTP 200 incluso con errores (el resultado esta en `code`), el token va en la
// cabecera Access-Token, los reportes diarios no pueden pasar de 30 dias y las listas vienen paginadas.

import http from "node:http";

export const APP_ID = "7123456789012345678";
export const APP_SECRET = "secreto-de-prueba-de-la-app-tiktok";
export const GOOD_CODE = "TT-AUTH-CODE-0001";
export const ACCESS_TOKEN = "TT-ACCESS-TOKEN-AAAA";

// 7003 esta autorizado pero TikTok no devuelve sus datos (queda «skipped»).
export const ADVERTISERS = {
  "7001": { name: "TikTok Reservi", currency: "USD", timezone: "America/Bogota", factor: 1 },
  "7002": { name: "TikTok Colombia", currency: "COP", timezone: "America/Bogota", factor: 4000 },
};
const AUTHORIZED = ["7001", "7002", "7003"];
export const CAMPAIGNS = [
  { id: "1801", name: "Video marca" },
  { id: "1802", name: "Tráfico web" },
];
/** El servidor de pruebas pagina de a pocas filas para ejercitar la paginacion (TikTok permite hasta 1000). */
const FAKE_PAGE_SIZE = 40;

const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Cifras deterministas de una campaña un dia: la prueba calcula lo mismo para comparar. */
export function tiktokInsight(advertiserId, date, idx) {
  const factor = ADVERTISERS[advertiserId].factor;
  const seed = (dayNumber(date) + idx * 4 + Number(advertiserId.slice(-2))) % 9;
  const spendCents = Math.round((8 + seed * 2 + idx * 5 + 0.41) * 100 * factor);
  return {
    spendCents,
    spend: (spendCents / 100).toFixed(2),
    impressions: 800 + seed * 90 + idx * 300,
    clicks: 15 + seed * 2 + idx * 6,
    reach: 600 + seed * 70 + idx * 200,
    conversion: seed % 4 === 0 ? 3 : 0,
  };
}

const DEFAULT_SCENARIO = {
  dialog: "approve", // approve | deny | badstate
  exchange: "ok", // ok | badcode
  tokens: "valid", // valid | expired (code 40105 con HTTP 200)
  report: "ok", // ok | ratelimit (code 40100) | server (code 50000)
};

export function startFakeTikTok(port, expectedRedirectUri) {
  let scenario = { ...DEFAULT_SCENARIO };
  let requests = [];
  let lastDialog = null;

  const reply = (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ request_id: "FAKE-REQUEST", ...body }));
  };
  const ok = (res, data) => reply(res, { code: 0, message: "OK", data });
  const fail = (res, code, message) => reply(res, { code, message });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.searchParams;
    let raw = "";
    for await (const chunk of req) raw += chunk;

    // --- control de la prueba ---
    if (url.pathname === "/__scenario" && req.method === "POST") {
      scenario = { ...scenario, ...JSON.parse(raw || "{}") };
      return reply(res, scenario);
    }
    if (url.pathname === "/__reset") {
      scenario = { ...DEFAULT_SCENARIO };
      requests = [];
      lastDialog = null;
      return reply(res, {});
    }
    if (url.pathname === "/__requests") return reply(res, { requests, lastDialog });

    // --- pantalla de autorizacion (navegador) ---
    if (url.pathname === "/portal/auth") {
      lastDialog = Object.fromEntries(p);
      requests.push({ path: "portal/auth" });
      if (p.get("app_id") !== APP_ID) return reply(res, { code: 40002, message: "Invalid app_id" }, 400);
      if (p.get("redirect_uri") !== expectedRedirectUri) return reply(res, { code: 40002, message: "redirect_uri no registrado en la app" }, 400);
      const back = new URL(p.get("redirect_uri"));
      if (scenario.dialog === "deny") back.search = new URLSearchParams({ error: "access_denied", state: p.get("state") }).toString();
      else back.search = new URLSearchParams({ auth_code: GOOD_CODE, state: scenario.dialog === "badstate" ? "estado-falso" : p.get("state") }).toString();
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // --- Marketing API ---
    const m = url.pathname.match(/^\/open_api\/v1\.3\/(.+)$/);
    if (!m) return reply(res, { code: 40002, message: `Ruta no soportada: ${url.pathname}` }, 404);
    const path = m[1];
    const token = req.headers["access-token"] ?? null;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path, method: req.method, token, query: Object.fromEntries(p), body: path.startsWith("oauth2") ? { ...body, secret: body.secret ? "[secreto]" : undefined } : body, tokenInUrl: p.has("access_token") });

    if (path === "oauth2/access_token/" && req.method === "POST") {
      if (body.app_id !== APP_ID || body.secret !== APP_SECRET) return fail(res, 40002, "Invalid app_id or secret");
      if (scenario.exchange === "badcode" || body.auth_code !== GOOD_CODE) return fail(res, 40002, "Invalid auth_code");
      return ok(res, { access_token: ACCESS_TOKEN, advertiser_ids: AUTHORIZED, scope: [1, 4, 9] });
    }

    if (scenario.tokens === "expired" || token !== ACCESS_TOKEN) return fail(res, 40105, "Access token is incorrect or has been revoked.");

    if (path === "advertiser/info/") {
      const ids = JSON.parse(p.get("advertiser_ids") ?? "[]");
      return ok(res, { list: ids.filter((id) => ADVERTISERS[id]).map((id) => ({ advertiser_id: id, name: ADVERTISERS[id].name, currency: ADVERTISERS[id].currency, timezone: ADVERTISERS[id].timezone, status: "STATUS_ENABLE" })) });
    }

    if (path === "report/integrated/get/") {
      if (scenario.report === "ratelimit") return fail(res, 40100, "Too many requests. Requests made too frequently.");
      if (scenario.report === "server") return fail(res, 50000, "System error");
      const id = p.get("advertiser_id");
      if (!ADVERTISERS[id]) return fail(res, 40002, "advertiser_id no autorizado");
      if (p.get("data_level") !== "AUCTION_CAMPAIGN" || p.get("report_type") !== "BASIC") return fail(res, 40002, "data_level o report_type no soportado");
      const dims = JSON.parse(p.get("dimensions") ?? "[]");
      if (!dims.includes("campaign_id") || !dims.includes("stat_time_day")) return fail(res, 40002, "Faltan dimensiones");
      const start = p.get("start_date");
      const end = p.get("end_date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")) return fail(res, 40002, "Fechas no validas");
      const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
      if (span > 30) return fail(res, 40002, "The time range for stat_time_day cannot exceed 30 days.");

      const rows = [];
      for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
        const date = new Date(t).toISOString().slice(0, 10);
        CAMPAIGNS.forEach((c, ci) => {
          const v = tiktokInsight(id, date, ci);
          rows.push({
            dimensions: { campaign_id: c.id, stat_time_day: `${date} 00:00:00` },
            metrics: { campaign_name: c.name, spend: v.spend, impressions: String(v.impressions), clicks: String(v.clicks), reach: String(v.reach), conversion: String(v.conversion) },
          });
        });
      }
      const pageSize = Math.min(Number(p.get("page_size") ?? 10), FAKE_PAGE_SIZE);
      const page = Number(p.get("page") ?? 1);
      return ok(res, {
        list: rows.slice((page - 1) * pageSize, page * pageSize),
        page_info: { page, page_size: pageSize, total_number: rows.length, total_page: Math.max(Math.ceil(rows.length / pageSize), 1) },
      });
    }
    return fail(res, 40002, `Ruta no soportada: ${path}`);
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
        },
        requests: () => requests,
        lastDialog: () => lastDialog,
      }),
    );
  });
}
