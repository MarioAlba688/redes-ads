// Prueba de extremo a extremo de la Fase 4 (Google Ads y TikTok Ads): conexion OAuth, cuentas (incluidas las de una
// administradora MCC), renovacion de tokens, sincronizacion de metricas, pantalla de Anuncios con varias plataformas,
// errores, desconexion, proceso en segundo plano y permisos. Usa servidores SIMULADOS de Google y TikTok (no toca
// cuentas reales ni hacen falta credenciales). Arranca por si misma la app (hace falta `npm run build`).
// ATENCION: vacia la base de pruebas (solo corre contra una base *_test).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";
import * as G from "./fake-google.mjs";
import * as T from "./fake-tiktok.mjs";
import { createChecker, createDb, findChrome, requireTestDb, startApp, waitFor, waitReady } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_PORT = Number(process.env.E2E_ADS_PORT ?? 3350);
const PLAIN_PORT = APP_PORT + 1; // sin credenciales de Google ni de TikTok
const WORKER_PORT = APP_PORT + 2; // con el proceso en segundo plano encendido
const GOOGLE_PORT = Number(process.env.E2E_FAKE_GOOGLE_PORT ?? 4050);
const TIKTOK_PORT = Number(process.env.E2E_FAKE_TIKTOK_PORT ?? 4060);
const APP = `http://localhost:${APP_PORT}`;
const PLAIN = `http://localhost:${PLAIN_PORT}`;
const WORKER = `http://localhost:${WORKER_PORT}`;
const SETUP_TOKEN = "codigo-de-prueba-123";
const SHOTS = process.env.E2E_SHOTS_DIR;

const ADMIN = { name: "Mario Alba", email: "mario@example.com", pass: "clave-admin-2026" };
const VIEWER = { name: "Vera Lectora", email: "vera@example.com", pass: "clave-vera-2026xx" };

const { raw: DB_URL, url: dbUrl } = requireTestDb();
const db = createDb(dbUrl);
const { check, fail, finish } = createChecker();

if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("Falta compilar la app: ejecuta `npm run build` antes de esta prueba.");
  process.exit(2);
}

// ---------------------------------------------------------------- fechas y cifras esperadas
const todayIn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const range = (since, until) => {
  const out = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
};
const norm = (s) => s.replace(/[  ]/g, " ");
const money = (v, currency) => new Intl.NumberFormat("es", { style: "currency", currency }).format(v);

// Cuentas que se esperan: tipo, id externo, zona horaria, moneda, funcion que da el gasto en diezmilesimas (la base guarda 4 decimales).
const ACCOUNTS = {
  g1111: { platform: "GOOGLE_ADS", id: "1111111111", name: "Tienda Google", tz: "America/Bogota", currency: "USD", tt: (d) => G.CAMPAIGNS.reduce((s, _c, ci) => s + Math.round(G.googleInsight("1111111111", d, ci).costMicros / 100), 0) },
  g3333: { platform: "GOOGLE_ADS", id: "3333333333", name: "Cliente A (MCC)", tz: "Europe/Madrid", currency: "EUR", tt: (d) => G.CAMPAIGNS.reduce((s, _c, ci) => s + Math.round(G.googleInsight("3333333333", d, ci).costMicros / 100), 0) },
  g4444: { platform: "GOOGLE_ADS", id: "4444444444", name: "Cliente B (MCC)", tz: "America/Bogota", currency: "COP", tt: (d) => G.CAMPAIGNS.reduce((s, _c, ci) => s + Math.round(G.googleInsight("4444444444", d, ci).costMicros / 100), 0) },
  t7001: { platform: "TIKTOK", id: "7001", name: "TikTok Reservi", tz: "America/Bogota", currency: "USD", tt: (d) => T.CAMPAIGNS.reduce((s, _c, ci) => s + T.tiktokInsight("7001", d, ci).spendCents * 100, 0) },
  t7002: { platform: "TIKTOK", id: "7002", name: "TikTok Colombia", tz: "America/Bogota", currency: "COP", tt: (d) => T.CAMPAIGNS.reduce((s, _c, ci) => s + T.tiktokInsight("7002", d, ci).spendCents * 100, 0) },
};
/** Gasto esperado (en diezmilesimas) de una cuenta en la ventana de `days` dias que termina en `windowUntil`; los datos solo llegan hasta «hoy» de la cuenta y 90 dias atras. */
const expectedTT = (acc, days, windowUntil) => {
  const untilA = todayIn(acc.tz);
  const from = [addDays(windowUntil, -(days - 1)), addDays(untilA, -89)].sort().at(-1);
  const to = [windowUntil, untilA].sort()[0];
  return from > to ? 0 : range(from, to).reduce((s, d) => s + acc.tt(d), 0);
};
/** «Hoy» de la ventana de la pantalla Anuncios: el mas adelantado entre las zonas de las cuentas que se ven. */
const windowUntil = (accs) => accs.map((a) => todayIn(a.tz)).sort().at(-1);

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const logs = [];
let google;
let tiktok;
let appA;
let appB;
let appC;
let browser;
try {
  await db.reset();
  google = await G.startFakeGoogle(GOOGLE_PORT, `${APP}/api/google/callback`);
  tiktok = await T.startFakeTikTok(TIKTOK_PORT, `${APP}/api/tiktok/callback`);

  // Variables vacias a proposito: la app de prueba no debe heredar del .env real ajustes de otras plataformas.
  const baseEnv = {
    DATABASE_URL: DB_URL,
    SETUP_TOKEN,
    ENCRYPTION_KEY,
    E2E_DATABASE_URL: "",
    META_APP_ID: "",
    META_APP_SECRET: "",
    META_SCOPES: "",
    META_LOGIN_CONFIG_ID: "",
    ANTHROPIC_API_KEY: "",
    GOOGLE_ADS_DEVELOPER_TOKEN: "",
    TZ: "UTC",
    WORKER_ENABLED: "false",
  };
  const withPlatforms = {
    GOOGLE_CLIENT_ID: G.CLIENT_ID,
    GOOGLE_CLIENT_SECRET: G.CLIENT_SECRET,
    GOOGLE_OAUTH_BASE_URL: `http://127.0.0.1:${GOOGLE_PORT}`,
    GOOGLE_ADS_API_BASE_URL: `http://127.0.0.1:${GOOGLE_PORT}`,
    TIKTOK_APP_ID: T.APP_ID,
    TIKTOK_APP_SECRET: T.APP_SECRET,
    TIKTOK_API_BASE_URL: `http://127.0.0.1:${TIKTOK_PORT}`,
  };
  appA = startApp({ root: ROOT, port: APP_PORT, logs, env: { ...baseEnv, ...withPlatforms, APP_URL: APP } });
  appB = startApp({
    root: ROOT,
    port: PLAIN_PORT,
    logs,
    env: { ...baseEnv, APP_URL: PLAIN, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", TIKTOK_APP_ID: "", TIKTOK_APP_SECRET: "", GOOGLE_OAUTH_BASE_URL: "", GOOGLE_ADS_API_BASE_URL: "", TIKTOK_API_BASE_URL: "" },
  });
  await Promise.all([waitReady(APP), waitReady(PLAIN)]);

  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const row = (name) => page.locator("tr", { hasText: name });
  const flash = (re) => page.getByText(re).first();
  const sql = (q, p) => db.sql(q, p);
  const acct = async (key) => (await sql("SELECT * FROM SocialAccount WHERE platform=? AND externalId=? AND kind='AD_ACCOUNT'", [ACCOUNTS[key].platform, ACCOUNTS[key].id]))[0];
  const rowsOf = async (key) => Number((await sql("SELECT COUNT(*) c FROM AdInsightDaily WHERE accountId=?", [(await acct(key)).id]))[0].c);
  const spendTT = async (key) => Number((await sql("SELECT CAST(ROUND(SUM(spend) * 10000) AS SIGNED) c FROM AdInsightDaily WHERE accountId=?", [(await acct(key)).id]))[0].c);
  const gReqs = () => google.requests();
  const tReqs = () => tiktok.requests();
  const connectFlow = async (label, urlRe) => {
    await page.goto(`${APP}/cuentas`);
    await page.getByRole("link", { name: label }).click();
    await page.waitForURL(urlRe);
  };

  // ---------------------------------------------------------- 0. instalacion y usuarios
  await page.goto(`${APP}/setup`);
  await page.getByLabel("Código de instalación").fill(SETUP_TOKEN);
  await page.getByLabel("Tu nombre").fill(ADMIN.name);
  await page.getByLabel("Correo").fill(ADMIN.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(ADMIN.pass);
  await page.getByLabel("Repite la contraseña").fill(ADMIN.pass);
  await page.getByRole("button", { name: "Crear administrador" }).click();
  await page.waitForURL(`${APP}/`);
  check("administrador creado", true);
  await sql("INSERT INTO User (id, email, name, passwordHash, role, active, failedLogins, createdAt, updatedAt) VALUES ('viewer-e2e-0001', ?, ?, ?, 'VIEWER', 1, 0, NOW(3), NOW(3))", [VIEWER.email, VIEWER.name, bcrypt.hashSync(VIEWER.pass, 4)]);

  // ---------------------------------------------------------- 1. antes de conectar
  await page.goto(`${APP}/cuentas`);
  const gLink = page.getByRole("link", { name: "Conectar Google Ads" });
  const tLink = page.getByRole("link", { name: "Conectar TikTok" });
  check("con credenciales, Google Ads y TikTok ofrecen su botón de conectar", (await gLink.isVisible()) && (await tLink.isVisible()));
  check("los botones apuntan a sus rutas de conexión", (await gLink.getAttribute("href")) === "/api/google/connect" && (await tLink.getAttribute("href")) === "/api/tiktok/connect");
  check("LinkedIn sigue como «Disponible en la Fase 5»", await page.getByRole("button", { name: "Disponible en la Fase 5" }).isVisible());
  await page.goto(`${APP}/anuncios`);
  check("sin cuentas, Anuncios invita a conectar cualquiera de las tres plataformas", await page.getByText(/Conecta Meta, Google Ads o TikTok Ads/).isVisible());

  // ---------------------------------------------------------- 2. conexion de Google Ads
  await connectFlow("Conectar Google Ads", /\/cuentas\?google=connected/);
  check("tras Google vuelve a /cuentas con el resumen (3 cuentas y 1 que no se pudo leer)", (await flash(/Google Ads conectado: 3 cuenta\(s\) publicitaria\(s\)/).isVisible()) && (await flash(/1 cuenta\(s\) no se pudieron leer/).isVisible()));
  const dialog = google.lastDialog();
  check("el cuadro de Google recibió el ID de cliente y la URL de retorno", dialog?.client_id === G.CLIENT_ID && dialog.redirect_uri === `${APP}/api/google/callback` && dialog.response_type === "code");
  check("pide el permiso de Google Ads, acceso offline y consentimiento (para recibir el token de renovación)", dialog?.scope?.split(" ").includes("https://www.googleapis.com/auth/adwords") && dialog.access_type === "offline" && dialog.prompt === "consent");
  check("envía un `state` aleatorio de 32+ caracteres y el secreto nunca viaja por el navegador", (dialog?.state ?? "").length >= 32 && !JSON.stringify(dialog).includes(G.CLIENT_SECRET));

  const gRows = await sql("SELECT * FROM SocialAccount WHERE platform='GOOGLE_ADS' ORDER BY externalId");
  check("se guardaron las 3 cuentas cliente (la administradora y la cancelada no)", gRows.map((r) => r.externalId).join() === "1111111111,3333333333,4444444444", gRows.map((r) => r.externalId).join());
  check("nombre, moneda y zona horaria de cada una", gRows.map((r) => `${r.name}:${r.currency}:${r.timezone}`).join("|") === "Tienda Google:USD:America/Bogota|Cliente A (MCC):EUR:Europe/Madrid|Cliente B (MCC):COP:America/Bogota");
  check("todas son cuentas publicitarias activas, conectadas por el administrador", gRows.every((r) => r.kind === "AD_ACCOUNT" && r.status === "ACTIVE" && r.connectedById !== null));
  check("las de la administradora (MCC) recuerdan a través de cuál se consultan; la de acceso directo, no", gRows[0].metadata?.loginCustomerId === null && gRows[1].metadata?.loginCustomerId === G.MCC_ID && gRows[2].metadata?.loginCustomerId === G.MCC_ID, JSON.stringify(gRows.map((r) => r.metadata?.loginCustomerId)));
  check("los dos tokens se guardan cifrados (v1.…), nunca en claro", gRows.every((r) => r.accessTokenEnc?.startsWith("v1.") && r.refreshTokenEnc?.startsWith("v1.") && !r.accessTokenEnc.includes("ACCESS") && !r.refreshTokenEnc.includes(G.REFRESH_TOKEN)));
  check("la conexión no muestra fecha de vencimiento (el token de renovación no vence; el de acceso se renueva solo)", gRows.every((r) => r.tokenExpiresAt === null && !!r.metadata?.accessExpiresAt));
  check("guarda los permisos concedidos y con qué cuenta de Google se conectó", gRows[0].scopes.includes("adwords") && gRows[0].metadata?.email === G.EMAIL);
  const listCall = gReqs().find((r) => r.path === "customers:listAccessibleCustomers");
  check("la primera llamada a la API usa el token de acceso como Bearer", listCall?.token === "ya29.ACCESS-TOKEN-1");
  const childCalls = gReqs().filter((r) => /FROM customer_client/.test(r.query ?? ""));
  check("las cuentas de la administradora se piden con login-customer-id de la MCC", childCalls.length === 1 && childCalls[0].loginCustomerId === G.MCC_ID);
  check("sin developer token configurado no se envía esa cabecera (Google ya no la exige)", gReqs().filter((r) => r.path.startsWith("customers")).every((r) => r.developerToken === null));

  // ---------------------------------------------------------- 3. primera sincronizacion de Google (90 dias)
  const synced = await waitFor(async () => (await rowsOf("g1111")) === 180 && (await rowsOf("g3333")) === 180 && (await rowsOf("g4444")) === 180, { timeout: 60_000 });
  check("la primera sincronización trae 90 días × 2 campañas por cuenta", !!synced, `${await rowsOf("g1111")}/${await rowsOf("g3333")}/${await rowsOf("g4444")}`);
  for (const key of ["g1111", "g3333", "g4444"]) {
    const a = ACCOUNTS[key];
    const expected = expectedTT(a, 90, todayIn(a.tz));
    check(`gasto guardado de ${a.name} (${a.currency}) = suma exacta de los micros de Google, sin errores de decimales`, (await spendTT(key)) === expected, `${await spendTT(key)} vs ${expected}`);
  }
  const gRange = (await sql("SELECT MIN(date) a, MAX(date) b FROM AdInsightDaily WHERE accountId=?", [(await acct("g3333")).id]))[0];
  check("las fechas van en la zona horaria de cada cuenta (Madrid ≠ Bogotá)", gRange.a.toISOString().slice(0, 10) === addDays(todayIn("Europe/Madrid"), -89) && gRange.b.toISOString().slice(0, 10) === todayIn("Europe/Madrid"));
  const sample = (await sql("SELECT reach, actions, campaignId FROM AdInsightDaily WHERE accountId=? ORDER BY date, campaignId LIMIT 1", [(await acct("g1111")).id]))[0];
  check("Google no informa alcance (0) y las conversiones se guardan como acciones", Number(sample.reach) === 0 && ["7001", "7002"].includes(sample.campaignId));
  const metrics = gReqs().filter((r) => /FROM campaign/.test(r.query ?? ""));
  check("las métricas se consultan con GAQL por día y campaña, con las fechas pedidas", metrics.length >= 3 && metrics.every((r) => /segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/.test(r.query) && /metrics\.cost_micros/.test(r.query)));
  check("la cuenta de una MCC se consulta con login-customer-id; la directa, sin él", metrics.filter((r) => r.path.includes("3333333333") || r.path.includes("4444444444")).every((r) => r.loginCustomerId === G.MCC_ID) && metrics.filter((r) => r.path.includes("/1111111111/")).every((r) => r.loginCustomerId === null));

  // ---------------------------------------------------------- 4. conexion de TikTok Ads
  await connectFlow("Conectar TikTok", /\/cuentas\?tiktok=connected/);
  check("tras TikTok vuelve a /cuentas con el resumen (2 cuentas y 1 que no se pudo leer)", (await flash(/TikTok Ads conectado: 2 cuenta\(s\) publicitaria\(s\)/).isVisible()) && (await flash(/1 cuenta\(s\) no se pudieron leer/).isVisible()));
  const tDialog = tiktok.lastDialog();
  check("la pantalla de TikTok recibió el ID de la app, la URL de retorno y un `state` aleatorio", tDialog?.app_id === T.APP_ID && tDialog.redirect_uri === `${APP}/api/tiktok/callback` && (tDialog.state ?? "").length >= 32 && !JSON.stringify(tDialog).includes(T.APP_SECRET));
  const tRows = await sql("SELECT * FROM SocialAccount WHERE platform='TIKTOK' ORDER BY externalId");
  check("se guardaron los 2 anunciantes con datos (el tercero no devolvió datos)", tRows.map((r) => `${r.externalId}:${r.name}:${r.currency}:${r.timezone}`).join("|") === "7001:TikTok Reservi:USD:America/Bogota|7002:TikTok Colombia:COP:America/Bogota");
  check("el token de TikTok se guarda cifrado y no vence solo", tRows.every((r) => r.accessTokenEnc?.startsWith("v1.") && !r.accessTokenEnc.includes(T.ACCESS_TOKEN) && r.refreshTokenEnc === null && r.tokenExpiresAt === null && r.scopes === "1,4,9"));
  const exch = tReqs().find((r) => r.path === "oauth2/access_token/");
  check("el código se cambió por el token con ID y secreto de la app (en el cuerpo, no en la URL)", exch?.body?.app_id === T.APP_ID && exch.body.auth_code === T.GOOD_CODE && exch.tokenInUrl === false);

  const tSynced = await waitFor(async () => (await rowsOf("t7001")) === 180 && (await rowsOf("t7002")) === 180, { timeout: 60_000 });
  check("la primera sincronización de TikTok trae 90 días × 2 campañas por cuenta", !!tSynced, `${await rowsOf("t7001")}/${await rowsOf("t7002")}`);
  for (const key of ["t7001", "t7002"]) {
    const a = ACCOUNTS[key];
    check(`gasto guardado de ${a.name} (${a.currency}) = suma exacta de lo que dijo TikTok`, (await spendTT(key)) === expectedTT(a, 90, todayIn(a.tz)), `${await spendTT(key)} vs ${expectedTT(a, 90, todayIn(a.tz))}`);
  }
  const reports7001 = tReqs().filter((r) => r.path === "report/integrated/get/" && r.query.advertiser_id === "7001");
  check("90 días se piden en 3 tramos de ≤ 30 días (TikTok rechaza más) y se recorren todas las páginas", reports7001.length === 6 && new Set(reports7001.map((r) => `${r.query.start_date}|${r.query.end_date}`)).size === 3, String(reports7001.length));
  check("todas las llamadas a la API llevan el token en la cabecera Access-Token (nunca en la URL)", tReqs().filter((r) => !["oauth2/access_token/", "portal/auth"].includes(r.path)).every((r) => r.token === T.ACCESS_TOKEN && r.tokenInUrl === false));
  const tSample = (await sql("SELECT reach, actions FROM AdInsightDaily WHERE accountId=? ORDER BY date LIMIT 1", [(await acct("t7001")).id]))[0];
  check("TikTok sí informa alcance", Number(tSample.reach) > 0);

  // ---------------------------------------------------------- 5. pantalla de Anuncios con varias plataformas
  await page.goto(`${APP}/anuncios`);
  await page.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
  const all = Object.values(ACCOUNTS);
  const wU = windowUntil(all);
  const text = norm(await page.locator("main").innerText());
  check("una sección por moneda: USD, EUR y COP (nunca se suman monedas distintas)", ["Cuentas en USD", "Cuentas en EUR", "Cuentas en COP"].every((t) => text.includes(t)));
  const usd = (expectedTT(ACCOUNTS.g1111, 30, wU) + expectedTT(ACCOUNTS.t7001, 30, wU)) / 10000;
  const eur = expectedTT(ACCOUNTS.g3333, 30, wU) / 10000;
  const cop = (expectedTT(ACCOUNTS.g4444, 30, wU) + expectedTT(ACCOUNTS.t7002, 30, wU)) / 10000;
  check("el gasto de 30 días suma Google y TikTok en la misma moneda (USD)", text.includes(norm(money(usd, "USD"))), money(usd, "USD"));
  check("el gasto de 30 días en EUR (solo Google) coincide", text.includes(norm(money(eur, "EUR"))), money(eur, "EUR"));
  check("el gasto de 30 días en COP (Google + TikTok) coincide", text.includes(norm(money(cop, "COP"))), money(cop, "COP"));
  check("«Por plataforma» aparece donde hay más de una (USD y COP) y no en EUR", (await page.getByRole("heading", { name: "Por plataforma" }).count()) === 2);
  const usdSection = norm(await page.locator("section", { has: page.getByRole("heading", { name: "Cuentas en USD" }) }).innerText());
  check("el desglose de USD muestra a Google Ads y a TikTok con su gasto", usdSection.includes("Google Ads") && usdSection.includes("TikTok") && usdSection.includes(norm(money(expectedTT(ACCOUNTS.g1111, 30, wU) / 10000, "USD"))) && usdSection.includes(norm(money(expectedTT(ACCOUNTS.t7001, 30, wU) / 10000, "USD"))));
  check("las campañas de ambas plataformas aparecen, cada una con su cuenta y plataforma", text.includes("Búsqueda marca") && text.includes("Video marca") && /Tienda Google · Google Ads/.test(text) && /TikTok Reservi · TikTok/.test(text));
  check("el encabezado nombra las plataformas conectadas", text.includes("Rendimiento de tus cuentas publicitarias de Google Ads, TikTok"));

  const platGroup = page.getByRole("group", { name: "Plataforma" });
  check("el filtro por plataforma ofrece Todas, Google Ads y TikTok (no Meta: no hay cuentas)", (await platGroup.getByRole("link").allInnerTexts()).join() === "Todas,Google Ads,TikTok");
  await page.getByLabel("Cuenta publicitaria").selectOption({ label: "Cliente A (MCC)" });
  await page.waitForURL(/cuenta=/);
  await platGroup.getByRole("link", { name: "TikTok", exact: true }).click();
  await page.waitForURL(/plataforma=TIKTOK/);
  check("al cambiar de plataforma se quita la cuenta elegida (era de otra)", !page.url().includes("cuenta="));
  const tOnly = norm(await page.locator("main").innerText());
  const tUntil = windowUntil([ACCOUNTS.t7001, ACCOUNTS.t7002]);
  check("solo TikTok: sus dos cuentas, sin Google, y el gasto de 30 días de TikTok coincide", tOnly.includes("TikTok Reservi") && !tOnly.includes("Tienda Google") && !tOnly.includes("Cuentas en EUR") && tOnly.includes(norm(money(expectedTT(ACCOUNTS.t7001, 30, tUntil) / 10000, "USD"))));
  check("con una sola plataforma ya no hay desglose «Por plataforma»", (await page.getByRole("heading", { name: "Por plataforma" }).count()) === 0);
  check("el selector de cuentas solo lista las de esa plataforma", (await page.getByLabel("Cuenta publicitaria").locator("option").allInnerTexts()).join() === "Todas las cuentas,TikTok Colombia,TikTok Reservi");
  await page.goto(`${APP}/anuncios?plataforma=GOOGLE_ADS&dias=7`);
  check("solo Google Ads con 7 días", (await page.getByRole("link", { name: "7 días" }).getAttribute("aria-current")) === "true" && !(await page.locator("main").innerText()).includes("TikTok Reservi"));
  await page.goto(`${APP}/anuncios?plataforma=INVENTADA&cuenta=otra`);
  check("una plataforma o cuenta inventada en la URL se ignora (muestra todo)", (await page.locator("main").innerText()).includes("Cuentas en USD"));

  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(`${APP}/anuncios`);
    await page.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, "ads-anuncios-claro.png"), fullPage: true });
    await page.goto(`${APP}/cuentas`);
    await page.screenshot({ path: path.join(SHOTS, "ads-cuentas-claro.png"), fullPage: true });
    const dark = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    await dark.addCookies(await ctx.cookies());
    const dp = await dark.newPage();
    await dp.goto(`${APP}/anuncios`);
    await dp.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
    await dp.screenshot({ path: path.join(SHOTS, "ads-anuncios-oscuro.png"), fullPage: true });
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await mob.addCookies(await ctx.cookies());
    const mp = await mob.newPage();
    await mp.goto(`${APP}/anuncios`);
    await mp.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
    await mp.screenshot({ path: path.join(SHOTS, "ads-anuncios-movil.png"), fullPage: true });
    await dark.close();
    await mob.close();
  }

  // ---------------------------------------------------------- 6. renovacion del token de acceso de Google
  await sql("UPDATE SocialAccount SET metadata = JSON_SET(metadata, '$.accessExpiresAt', '2020-01-01T00:00:00.000Z') WHERE platform='GOOGLE_ADS'");
  const refreshesBefore = google.refreshCalls();
  await page.goto(`${APP}/cuentas`);
  await page.getByRole("button", { name: "Sincronizar todas" }).click();
  await flash(/Se sincronizaron 5 cuentas\./).waitFor({ timeout: 60_000 });
  check("«Sincronizar todas» incluye las cuentas de Google y de TikTok (5)", true);
  check("con el token de acceso vencido se pidió uno nuevo con el de renovación, una sola vez para las 3 cuentas", google.refreshCalls() - refreshesBefore === 1, String(google.refreshCalls() - refreshesBefore));
  const renewed = gReqs().filter((r) => r.token === "ya29.ACCESS-TOKEN-2");
  check("las 3 cuentas usaron el token nuevo", renewed.filter((r) => /FROM campaign/.test(r.query ?? "")).length === 3);
  const g1 = await acct("g1111");
  check("el token nuevo se guarda cifrado y se actualiza su vencimiento (~1 hora)", g1.accessTokenEnc.startsWith("v1.") && Date.parse(g1.metadata.accessExpiresAt) - Date.now() > 3000_000);
  await row("Tienda Google").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Google").getByText(/Sincronizado: \d+ registros/).waitFor({ timeout: 30_000 });
  check("mientras el token sirve no se vuelve a renovar", google.refreshCalls() - refreshesBefore === 1);
  check("sincronizar dos veces no duplica filas (reemplaza la ventana)", (await rowsOf("g1111")) === 180 && (await rowsOf("t7001")) === 180);

  // ---------------------------------------------------------- 7. errores de la API de Google
  google.setScenario({ fail: { "1111111111": "ratelimit" } });
  await page.goto(`${APP}/cuentas`);
  await row("Tienda Google").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Google").getByText(/Google pidió esperar por exceso de consultas/).first().waitFor({ timeout: 20_000 });
  const rl = await acct("g1111");
  check("un límite de uso no marca la cuenta como vencida; guarda el motivo y conserva los datos", rl.status === "ACTIVE" && /esperar/.test(rl.lastError ?? "") && (await rowsOf("g1111")) === 180);
  google.setScenario({ fail: { "1111111111": "server" } });
  await row("Tienda Google").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Google").getByText(/Google Ads tuvo un problema temporal/).first().waitFor({ timeout: 20_000 });
  google.setScenario({ fail: { "1111111111": "permission" } });
  await row("Tienda Google").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Google").getByText(/no tiene acceso a esta cuenta de Google Ads/).first().waitFor({ timeout: 20_000 });
  check("sin permiso sobre la cuenta, o con un fallo temporal de Google, tampoco se marca como vencida", (await acct("g1111")).status === "ACTIVE");
  google.setScenario({ fail: {} });

  // ---------------------------------------------------------- 8. conexion de Google vencida (401) y reconexion
  google.setScenario({ accessTokens: "expired" });
  await page.goto(`${APP}/cuentas`);
  await row("Cliente B (MCC)").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Cliente B (MCC)").getByText(/venció o fue revocada\. Vuelve a conectar Google Ads/).first().waitFor({ timeout: 20_000 });
  check("Google dice «credenciales inválidas» (401): la cuenta pasa a VENCIDA", (await acct("g4444")).status === "EXPIRED");
  await page.goto(`${APP}/cuentas`);
  check("/cuentas la muestra como «Vencida»", await row("Cliente B (MCC)").getByText("Vencida").isVisible());
  await page.goto(`${APP}/anuncios`);
  check("/anuncios avisa de qué cuenta y plataforma hay que reconectar, y sigue mostrando los datos históricos", (await page.getByText(/Cliente B \(MCC\) \(Google Ads\)/).first().isVisible()) && (await page.locator("main").innerText()).includes("Cuentas en COP"));
  google.setScenario({ accessTokens: "valid" });
  const refreshBeforeReconnect = (await acct("g4444")).refreshTokenEnc;
  await connectFlow("Reconectar Google Ads", /\/cuentas\?google=connected/);
  const back = await acct("g4444");
  check("reconectar reactiva la cuenta con tokens nuevos y no duplica cuentas", back.status === "ACTIVE" && back.lastError === null && back.refreshTokenEnc !== refreshBeforeReconnect && Number((await sql("SELECT COUNT(*) c FROM SocialAccount WHERE platform='GOOGLE_ADS'"))[0].c) === 3);

  // ---------------------------------------------------------- 9. errores de TikTok
  tiktok.setScenario({ report: "ratelimit" });
  await page.goto(`${APP}/cuentas`);
  await row("TikTok Reservi").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("TikTok Reservi").getByText(/TikTok pidió esperar por exceso de consultas/).first().waitFor({ timeout: 20_000 });
  check("el límite de TikTok (código 40100 con HTTP 200) se entiende y no vence la conexión", (await acct("t7001")).status === "ACTIVE");
  tiktok.setScenario({ report: "server" });
  await row("TikTok Reservi").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("TikTok Reservi").getByText(/TikTok tuvo un problema temporal/).first().waitFor({ timeout: 20_000 });
  tiktok.setScenario({ report: "ok", tokens: "expired" });
  await row("TikTok Reservi").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("TikTok Reservi").getByText(/venció o fue revocada\. Vuelve a conectar TikTok Ads/).first().waitFor({ timeout: 20_000 });
  check("un token revocado (código 40105 con HTTP 200) deja la cuenta en VENCIDA y conserva los datos", (await acct("t7001")).status === "EXPIRED" && (await rowsOf("t7001")) === 180);
  tiktok.setScenario({ tokens: "valid" });
  await connectFlow("Reconectar TikTok", /\/cuentas\?tiktok=connected/);
  check("reconectar TikTok la reactiva", (await acct("t7001")).status === "ACTIVE" && Number((await sql("SELECT COUNT(*) c FROM SocialAccount WHERE platform='TIKTOK'"))[0].c) === 2);

  // ---------------------------------------------------------- 10. cancelar, state invalido y otros fallos de la conexion
  const totalAccounts = async () => Number((await sql("SELECT COUNT(*) c FROM SocialAccount"))[0].c);
  const countBefore = await totalAccounts();
  google.setScenario({ dialog: "deny" });
  await connectFlow("Reconectar Google Ads", /google=denied/);
  check("Google: si cancela, se avisa y no se guarda nada", (await flash(/Cancelaste la conexión en Google/).isVisible()) && (await totalAccounts()) === countBefore);
  google.setScenario({ dialog: "badstate" });
  await connectFlow("Reconectar Google Ads", /google=bad_state/);
  check("Google: un `state` que no coincide se rechaza (protección CSRF)", await flash(/expiró o no es válida/).isVisible());
  google.setScenario({ dialog: "approve" });
  await page.goto(`${APP}/api/google/callback?code=${encodeURIComponent(G.GOOD_CODE)}&state=inventado`);
  check("Google: llamar al callback directo, sin haber empezado el flujo, se rechaza", /google=bad_state/.test(page.url()));

  const tokenBefore = (await acct("g1111")).refreshTokenEnc;
  google.setScenario({ refreshToken: "omit" });
  await connectFlow("Reconectar Google Ads", /google=no_refresh/);
  check("Google: sin token de renovación no se guarda (duraría una hora) y se explica cómo resolverlo", (await flash(/no entregó el permiso de larga duración/).isVisible()) && (await acct("g1111")).refreshTokenEnc === tokenBefore);
  google.setScenario({ refreshToken: "give", accessible: "notapproved" });
  await connectFlow("Reconectar Google Ads", /google=not_approved/);
  check("Google: si el proyecto de Google Cloud no tiene acceso a la API, dice qué pedir y dónde", await flash(/proyecto de Google Cloud todavía no tiene acceso a la API de Google Ads.*Explorer o Básico/).isVisible());
  google.setScenario({ accessible: "empty" });
  await connectFlow("Reconectar Google Ads", /google=connected/);
  check("Google: si la cuenta de Google no tiene cuentas de Google Ads, se explica", await flash(/no devolvió ninguna cuenta de Google Ads/).isVisible());
  google.setScenario({ accessible: "ok", tokenEndpoint: "invalid_client" });
  await connectFlow("Reconectar Google Ads", /google=bad_client/);
  check("Google: un ID o secreto de cliente incorrecto se indica (y no se confunde con una cuenta vencida)", await flash(/rechazó el ID o el secreto de cliente de OAuth/).isVisible());
  google.setScenario({ tokenEndpoint: "ok" });
  await connectFlow("Reconectar Google Ads", /google=connected/);
  const usedCallback = await (async () => {
    const urls = [];
    page.on("request", (r) => r.url().includes("/api/google/callback") && urls.push(r.url()));
    await connectFlow("Reconectar Google Ads", /google=connected/);
    return urls.find((u) => u.includes("code="));
  })();
  await page.goto(usedCallback);
  check("Google: repetir un callback ya usado se rechaza (el state es de un solo uso)", /google=bad_state/.test(page.url()));

  tiktok.setScenario({ dialog: "deny" });
  await connectFlow("Reconectar TikTok", /tiktok=denied/);
  check("TikTok: si cancela, se avisa y no se guarda nada", (await flash(/Cancelaste la autorización en TikTok/).isVisible()) && (await totalAccounts()) === countBefore);
  tiktok.setScenario({ dialog: "badstate" });
  await connectFlow("Reconectar TikTok", /tiktok=bad_state/);
  check("TikTok: un `state` que no coincide se rechaza", await flash(/expiró o no es válida/).isVisible());
  tiktok.setScenario({ dialog: "approve", exchange: "badcode" });
  await connectFlow("Reconectar TikTok", /tiktok=error/);
  check("TikTok: si el código no se puede cambiar por un token, se avisa sin guardar nada", (await flash(/No se pudo completar la conexión con TikTok Ads/).isVisible()) && (await totalAccounts()) === countBefore);
  tiktok.setScenario({ exchange: "ok" });
  await page.goto(`${APP}/api/tiktok/callback?auth_code=${encodeURIComponent(T.GOOD_CODE)}&state=inventado`);
  check("TikTok: el callback directo, sin haber empezado el flujo, se rechaza", /tiktok=bad_state/.test(page.url()));

  // ---------------------------------------------------------- 11. proceso en segundo plano (tercera instancia, con worker)
  appC = startApp({ root: ROOT, port: WORKER_PORT, logs, env: { ...baseEnv, ...withPlatforms, APP_URL: WORKER, WORKER_ENABLED: "true", WORKER_INTERVAL_SECONDS: "1" } });
  await waitReady(WORKER);
  await new Promise((r) => setTimeout(r, 4000)); // deja que pase su primera vuelta con todo al dia
  const tikBefore = tReqs().filter((r) => r.path === "report/integrated/get/").length;
  await sql("UPDATE SocialAccount SET lastSyncedAt = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 HOUR) WHERE platform='TIKTOK' AND externalId='7002'");
  check("una cuenta de TikTok sin sincronizar hace más de 6 horas la sincroniza el proceso en segundo plano", !!(await waitFor(async () => Date.now() - Date.parse(`${(await sql("SELECT DATE_FORMAT(lastSyncedAt, '%Y-%m-%dT%H:%i:%sZ') t FROM SocialAccount WHERE platform='TIKTOK' AND externalId='7002'"))[0].t}`) < 60_000, { timeout: 40_000 })) && tReqs().filter((r) => r.path === "report/integrated/get/").length > tikBefore);
  // Token de renovación revocado: el worker (proceso sin memoria de tokens) lo descubre al renovar.
  google.setScenario({ refresh: "revoked" });
  await sql("UPDATE SocialAccount SET metadata = JSON_SET(metadata, '$.accessExpiresAt', '2020-01-01T00:00:00.000Z'), lastSyncedAt = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 HOUR) WHERE platform='GOOGLE_ADS' AND externalId='3333333333'");
  check("si Google revoca el token de renovación, el worker deja la cuenta VENCIDA con el motivo", !!(await waitFor(async () => (await acct("g3333")).status === "EXPIRED", { timeout: 40_000 })) && /venció o fue revocada/.test((await acct("g3333")).lastError ?? ""));
  google.setScenario({ refresh: "ok" });

  // ---------------------------------------------------------- 12. desconectar
  await page.goto(`${APP}/cuentas`);
  page.once("dialog", (d) => d.accept());
  await row("TikTok Colombia").getByRole("button", { name: "Desconectar" }).click();
  await row("TikTok Colombia").getByText("Desconectada").waitFor({ timeout: 10_000 });
  const gone = await acct("t7002");
  check("desconectar TikTok borra el token y marca la cuenta como REVOCADA; el historial se conserva", gone.status === "REVOKED" && gone.accessTokenEnc === null && (await rowsOf("t7002")) === 180);
  page.once("dialog", (d) => d.accept());
  await row("Cliente A (MCC)").getByRole("button", { name: "Desconectar" }).click();
  await row("Cliente A (MCC)").getByText("Desconectada").waitFor({ timeout: 10_000 });
  const goneG = await acct("g3333");
  check("desconectar Google borra ambos tokens (acceso y renovación)", goneG.status === "REVOKED" && goneG.accessTokenEnc === null && goneG.refreshTokenEnc === null && (await rowsOf("g3333")) === 180);
  await page.goto(`${APP}/cuentas`);
  check("una cuenta desconectada ya no ofrece botones", (await row("Cliente A (MCC)").getByRole("button").count()) === 0);
  await page.goto(`${APP}/anuncios`);
  check("sus datos siguen apareciendo en Anuncios", (await page.locator("main").innerText()).includes("Cuentas en EUR"));

  // ---------------------------------------------------------- 13. permisos: solo lectura
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const v = await vctx.newPage();
  await v.goto(`${APP}/login`);
  await v.getByLabel("Correo").fill(VIEWER.email);
  await v.getByLabel("Contraseña", { exact: true }).fill(VIEWER.pass);
  await v.getByRole("button", { name: "Entrar" }).click();
  await v.waitForURL(`${APP}/`);
  await v.goto(`${APP}/cuentas`);
  check("solo lectura: no ve botones de conectar, sincronizar ni desconectar", (await v.getByRole("link", { name: /Conectar|Reconectar/ }).count()) === 0 && (await v.getByRole("button", { name: /Sincronizar|Desconectar/ }).count()) === 0);
  await v.goto(`${APP}/anuncios`);
  await v.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
  check("solo lectura: sí ve los anuncios de todas las plataformas, sin «Sincronizar todas»", (await v.locator("main").innerText()).includes("Google Ads") && (await v.getByRole("button", { name: "Sincronizar todas" }).count()) === 0);
  const dialogsG = gReqs().filter((r) => r.path === "auth").length;
  const dialogsT = tReqs().filter((r) => r.path === "portal/auth").length;
  await v.goto(`${APP}/api/google/connect`);
  await v.goto(`${APP}/api/tiktok/connect`);
  check("solo lectura: las rutas de conexión no lo mandan a Google ni a TikTok ni crean la cookie de `state`", gReqs().filter((r) => r.path === "auth").length === dialogsG && tReqs().filter((r) => r.path === "portal/auth").length === dialogsT && !(await vctx.cookies()).some((c) => /redes_(google|tiktok)_state/.test(c.name)));

  // ---------------------------------------------------------- 14. sin credenciales en el servidor (segunda instancia)
  await page.goto(`${PLAIN}/cuentas`);
  const plain = await page.locator("main").innerText();
  check("sin credenciales se explica qué falta para Google Ads y para TikTok, sin botones de conectar", /GOOGLE_CLIENT_ID/.test(plain) && /GOOGLE_CLIENT_SECRET/.test(plain) && /TIKTOK_APP_ID/.test(plain) && (await page.getByRole("link", { name: /Conectar (Google|TikTok)/ }).count()) === 0);
  await page.goto(`${PLAIN}/api/google/connect`);
  check("/api/google/connect sin configurar vuelve con un aviso claro", /google=not_configured/.test(page.url()) && (await page.getByText(/faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET/).isVisible()));
  await page.goto(`${PLAIN}/api/tiktok/connect`);
  check("/api/tiktok/connect sin configurar vuelve con un aviso claro", /tiktok=not_configured/.test(page.url()) && (await page.getByText(/faltan TIKTOK_APP_ID y TIKTOK_APP_SECRET/).isVisible()));
  await page.goto(`${PLAIN}/cuentas`);
  await row("Tienda Google").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Google").getByText(/Google Ads no está configurado en este servidor/).waitFor({ timeout: 10_000 });
  await row("TikTok Reservi").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("TikTok Reservi").getByText(/TikTok Ads no está configurado en este servidor/).waitFor({ timeout: 10_000 });
  check("sincronizar sin configurar da un error claro por plataforma, no un fallo", true);

  // ---------------------------------------------------------- 15. secretos y auditoria
  const html = [await (await ctx.request.get(`${APP}/cuentas`)).text(), await (await ctx.request.get(`${APP}/anuncios`)).text(), await (await ctx.request.get(`${APP}/equipo`)).text()].join("\n");
  const secrets = [G.CLIENT_SECRET, G.REFRESH_TOKEN, T.APP_SECRET, T.ACCESS_TOKEN, "ya29.", "accessTokenEnc", "refreshTokenEnc"];
  check("ninguna pantalla contiene secretos, tokens ni su versión cifrada", !secrets.some((s) => html.includes(s)) && !(await sql("SELECT accessTokenEnc, refreshTokenEnc FROM SocialAccount")).some((r) => (r.accessTokenEnc && html.includes(r.accessTokenEnc)) || (r.refreshTokenEnc && html.includes(r.refreshTokenEnc))));
  const audits = await sql("SELECT action, detail FROM AuditLog");
  const kinds = new Set(audits.map((a) => a.action));
  const wanted = ["google.connected", "google.synced", "google.connect_denied", "google.connect_rejected", "google.connect_failed", "google.disconnected", "tiktok.connected", "tiktok.synced", "tiktok.connect_denied", "tiktok.connect_rejected", "tiktok.connect_failed", "tiktok.disconnected", "ads.synced_all"];
  check("la auditoría registra conexión, sincronización, cancelación, rechazo, fallo y desconexión de cada plataforma", wanted.every((k) => kinds.has(k)), wanted.filter((k) => !kinds.has(k)).join());
  check("la auditoría y los registros de la app no contienen tokens ni secretos", !secrets.slice(0, 5).some((s) => JSON.stringify(audits).includes(s) || logs.join("\n").includes(s)));
  check("ninguna llamada a Google salió con un Bearer desconocido ni a TikTok sin token", gReqs().filter((r) => r.token).every((r) => /^ya29\.ACCESS-TOKEN-\d+$/.test(r.token)) && tReqs().filter((r) => !["oauth2/access_token/", "portal/auth"].includes(r.path)).every((r) => r.token === T.ACCESS_TOKEN));
  check("la app no registró errores internos en toda la prueba", !logs.some((l) => /error interno|fallo al sincronizar|Unhandled|TypeError/.test(l)), logs.filter((l) => /error interno|fallo al sincronizar|Unhandled|TypeError/.test(l)).slice(0, 3).join(" | "));
} catch (e) {
  fail("excepción en el recorrido", String(e?.stack ?? e).slice(0, 900));
  console.log("\n--- ultimas lineas de la app ---");
  console.log(logs.slice(-30).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [appA, appB, appC]) child?.kill();
  await google?.close().catch(() => {});
  await tiktok?.close().catch(() => {});
}

process.exit(finish());
