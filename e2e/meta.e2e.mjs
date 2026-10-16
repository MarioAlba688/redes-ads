// Prueba de extremo a extremo de la Fase 2 (Meta): conexion OAuth, cuentas, sincronizacion,
// pantalla de anuncios, errores y permisos. Usa un servidor de Meta SIMULADO (fake-meta.mjs),
// asi que no toca Meta de verdad ni hacen falta credenciales.
//
// Arranca por si misma la app (necesita `npm run build` hecho) y el servidor falso.
// Instrucciones en README.md ("Pruebas de extremo a extremo").
// ATENCION: vacia la base de pruebas (solo corre contra una base *_test).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";
import { createChecker, createDb, findChrome, requireTestDb, waitFor } from "./helpers.mjs";
import { ACCOUNTS, APP_ID, APP_SECRET, CAMPAIGNS, LONG_TOKEN, PAGE_TOKEN, insightFor, startFakeMeta } from "./fake-meta.mjs";
import { startLatencyProxy } from "./latency-proxy.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_PORT = Number(process.env.E2E_META_PORT ?? 3200);
const PLAIN_PORT = APP_PORT + 1; // segunda instancia SIN credenciales de Meta
const FAKE_PORT = Number(process.env.E2E_FAKE_META_PORT ?? 4010);
const APP = `http://localhost:${APP_PORT}`;
const PLAIN = `http://localhost:${PLAIN_PORT}`;
const SETUP_TOKEN = "codigo-de-prueba-123";
const SHOTS = process.env.E2E_SHOTS_DIR;

const ADMIN = { name: "Mario Alba", email: "mario@example.com", pass: "clave-admin-2026" };
const VIEWER = { name: "Vera Lectora", email: "vera@example.com", pass: "clave-vera-2026x" };

const { raw: DB_URL, url: dbUrl } = requireTestDb();
const db = createDb(dbUrl);
const { check, fail, finish } = createChecker();

if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("Falta compilar la app: ejecuta `npm run build` antes de esta prueba.");
  process.exit(2);
}

// ---------------------------------------------------------------- utilidades de fecha
const todayIn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const range = (since, until) => {
  const out = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
};
const expectedCents = (account, since, until) =>
  range(since, until).reduce((sum, d) => sum + CAMPAIGNS.reduce((s, _c, ci) => s + insightFor(account, d, ci).spendCents, 0), 0);
const money = (cents, currency) => new Intl.NumberFormat("es", { style: "currency", currency }).format(cents / 100);
const norm = (s) => s.replace(/[  ]/g, " ");

// ---------------------------------------------------------------- procesos
const logs = [];
function startApp(port, env) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => {
    logs.push(...String(chunk).split("\n").filter(Boolean).map((l) => `[:${port}] ${l}`));
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  return child;
}
async function waitReady(base) {
  const ok = await waitFor(async () => {
    try {
      return (await fetch(`${base}/login`, { redirect: "manual" })).status < 500;
    } catch {
      return false;
    }
  }, { timeout: 60_000, interval: 700 });
  if (!ok) throw new Error(`La app no respondio en ${base}`);
}

const ENCRYPTION_KEY = randomBytes(32).toString("base64");

let fake;
let appA;
let appB;
let browser;
let latency;
try {
  await db.reset();
  fake = await startFakeMeta(FAKE_PORT, `${APP}/api/meta/callback`);

  // Opcional: la app ve la base "lejos" (E2E_DB_LATENCY_MS por sentido; 100 ~ 200 ms por consulta).
  // La prueba consulta la base directamente, sin retraso.
  const latencyMs = Number(process.env.E2E_DB_LATENCY_MS ?? 0);
  let appDbUrl = DB_URL;
  if (latencyMs > 0) {
    latency = await startLatencyProxy({ targetHost: dbUrl.hostname, targetPort: Number(dbUrl.port || 3306), delayMs: latencyMs });
    const u = new URL(DB_URL);
    u.hostname = "127.0.0.1";
    u.port = String(latency.port);
    appDbUrl = u.toString();
    console.log(`(la app usa la base con ${latencyMs * 2} ms de latencia por consulta)`);
  }
  // Variables vacias a proposito: la app de prueba no debe heredar del .env real ajustes de Meta
  // (permisos limitados, configuracion de Facebook Login for Business...).
  const baseEnv = { DATABASE_URL: appDbUrl, SETUP_TOKEN, ENCRYPTION_KEY, E2E_DATABASE_URL: "", META_SCOPES: "", META_LOGIN_CONFIG_ID: "", MEDIA_PUBLIC_BASE_URL: "" };

  appA = startApp(APP_PORT, {
    ...baseEnv,
    APP_URL: APP,
    META_APP_ID: APP_ID,
    META_APP_SECRET: APP_SECRET,
    META_API_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
  });
  // B: sin Meta configurado, y con la direccion de ejemplo del manual en MEDIA_PUBLIC_BASE_URL (el error real de un usuario).
  appB = startApp(PLAIN_PORT, { ...baseEnv, APP_URL: PLAIN, META_APP_ID: "", META_APP_SECRET: "", META_API_BASE_URL: "", MEDIA_PUBLIC_BASE_URL: "https://palabras-al-azar.trycloudflare.com" });
  await Promise.all([waitReady(APP), waitReady(PLAIN)]);

  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

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

  await db.sql(
    "INSERT INTO User (id, email, name, passwordHash, role, active, failedLogins, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'VIEWER', 1, 0, NOW(3), NOW(3))",
    ["viewer-e2e-0001", VIEWER.email, VIEWER.name, bcrypt.hashSync(VIEWER.pass, 4)],
  );

  // ---------------------------------------------------------- 1. antes de conectar
  await page.goto(`${APP}/cuentas`);
  const connect = page.getByRole("link", { name: "Conectar Meta" });
  check("con Meta configurado se ofrece 'Conectar Meta'", await connect.isVisible());
  check("el boton apunta a /api/meta/connect", (await connect.getAttribute("href")) === "/api/meta/connect");
  check("el menu tiene 'Anuncios' habilitado", (await page.getByRole("link", { name: "Anuncios" }).count()) === 1);
  await page.goto(`${APP}/anuncios`);
  check("sin cuentas, Anuncios invita a conectar Meta", await page.getByText("Aún no hay cuentas publicitarias").isVisible());

  // ---------------------------------------------------------- 2. conexion OAuth
  const callbackUrls = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/meta/callback")) callbackUrls.push(r.url());
  });
  await page.goto(`${APP}/cuentas`);
  await page.getByRole("link", { name: "Conectar Meta" }).click();
  await page.waitForURL(/\/cuentas\?meta=connected/);
  const banner = await page.getByRole("status").first().innerText();
  check("tras Facebook vuelve a /cuentas con el resumen", /2 cuenta\(s\) publicitaria\(s\), 2 página\(s\) de Facebook y 1 cuenta\(s\) de Instagram/.test(banner), banner.slice(0, 120));

  const dialog = fake.lastDialog();
  check("el cuadro de Facebook recibio el ID de la app", dialog?.client_id === APP_ID);
  check("pide los permisos de anuncios, portafolio comercial, paginas e Instagram", ["ads_read", "business_management", "pages_show_list", "pages_manage_posts", "instagram_content_publish"].every((s) => dialog?.scope?.split(",").includes(s)));
  check("envia un `state` aleatorio de 32+ caracteres", (dialog?.state ?? "").length >= 32, `${(dialog?.state ?? "").length} caracteres`);
  check("la URL de retorno es /api/meta/callback", dialog?.redirect_uri === `${APP}/api/meta/callback`);
  check("el secreto de la app nunca viajo por el navegador", !JSON.stringify(dialog).includes(APP_SECRET));

  // ---------------------------------------------------------- 3. cuentas guardadas
  const accounts = await db.sql("SELECT * FROM SocialAccount ORDER BY kind, externalId");
  const by = (kind) => accounts.filter((a) => a.kind === kind);
  check("se guardaron 2 cuentas publicitarias, 2 paginas y 1 Instagram", by("AD_ACCOUNT").length === 2 && by("FACEBOOK_PAGE").length === 2 && by("INSTAGRAM_PROFILE").length === 1, accounts.map((a) => a.kind).join(","));
  check("todas son de Meta y estan activas", accounts.every((a) => a.platform === "META" && a.status === "ACTIVE"));
  check("moneda y zona horaria de cada cuenta publicitaria", by("AD_ACCOUNT").map((a) => `${a.externalId}:${a.currency}:${a.timezone}`).join("|") === "1001:USD:America/Bogota|1002:COP:America/Bogota");
  const ig = by("INSTAGRAM_PROFILE")[0];
  check("Instagram queda vinculado a su pagina y con @usuario", ig?.handle === "@mimarca" && ig?.metadata?.pageId === "P-1", JSON.stringify(ig?.metadata));
  check("los tokens se guardan cifrados (v1.…) y nunca en texto plano", accounts.every((a) => a.accessTokenEnc?.startsWith("v1.") && !a.accessTokenEnc.includes(LONG_TOKEN) && !a.accessTokenEnc.includes("PAGE-TOKEN")));
  const days = (d) => (new Date(d).getTime() - Date.now()) / 86_400_000;
  check("el token de la persona vence en ~60 dias y el de la pagina no vence", by("AD_ACCOUNT").every((a) => days(a.tokenExpiresAt) > 59 && days(a.tokenExpiresAt) < 61) && by("FACEBOOK_PAGE").every((a) => a.tokenExpiresAt === null));
  check("se guardaron los permisos concedidos", by("AD_ACCOUNT")[0].scopes.includes("ads_read"));
  check("conecto el administrador", accounts.every((a) => a.connectedById !== null));

  // ---------------------------------------------------------- 4. primera sincronizacion (90 dias, en segundo plano)
  const tz = "America/Bogota";
  const until = todayIn(tz);
  const since90 = addDays(until, -89);
  const idOf = (ext) => accounts.find((a) => a.kind === "AD_ACCOUNT" && a.externalId === ext).id;
  const countRows = async (accountId) => Number((await db.sql("SELECT COUNT(*) c FROM AdInsightDaily WHERE accountId=?", [accountId]))[0].c);

  const synced = await waitFor(async () => (await countRows(idOf("1001"))) === 180 && (await countRows(idOf("1002"))) === 180, { timeout: 45_000 });
  check("la primera sincronizacion trae 90 dias x 2 campañas por cuenta", !!synced, `1001=${await countRows(idOf("1001"))} 1002=${await countRows(idOf("1002"))}`);
  for (const acc of ACCOUNTS) {
    const sum = Number((await db.sql("SELECT CAST(ROUND(SUM(spend) * 100) AS SIGNED) c FROM AdInsightDaily WHERE accountId=?", [idOf(acc.account_id)]))[0].c);
    check(`gasto guardado de ${acc.currency} = suma exacta de lo que dijo Meta (sin errores de decimales)`, sum === expectedCents(acc, since90, until), `${sum} vs ${expectedCents(acc, since90, until)}`);
  }
  const dates = await db.sql("SELECT MIN(date) a, MAX(date) b FROM AdInsightDaily WHERE accountId=?", [idOf("1001")]);
  check("el rango pedido va en la zona horaria de la cuenta", dates[0].a.toISOString().slice(0, 10) === since90 && dates[0].b.toISOString().slice(0, 10) === until, `${dates[0].a.toISOString().slice(0, 10)}..${dates[0].b.toISOString().slice(0, 10)} esperado ${since90}..${until}`);
  const sample = (await db.sql("SELECT reach, impressions, actions FROM AdInsightDaily WHERE accountId=? LIMIT 1", [idOf("1001")]))[0];
  check("se guardan alcance y acciones", Number(sample.reach) > 0 && sample.actions?.link_click >= 0, JSON.stringify(sample, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));

  const reqs = fake.requests();
  check("todas las llamadas llevaron appsecret_proof valido", reqs.filter((r) => r.token).every((r) => r.proofOk), `${reqs.filter((r) => r.token && !r.proofOk).length} invalidas`);
  check("recorrio las 2 paginas de cuentas publicitarias por cursor", reqs.filter((r) => r.path === "me/adaccounts").length === 2);
  check("recorrio las 4 paginas de metricas de una cuenta por cursor", reqs.filter((r) => r.path === "act_1001/insights").length === 4, String(reqs.filter((r) => r.path === "act_1001/insights").length));
  check("las metricas se pidieron con el token de la persona (no el de la pagina)", reqs.filter((r) => r.path.endsWith("/insights")).every((r) => r.token === LONG_TOKEN));

  // ---------------------------------------------------------- 5. pantalla de anuncios
  const until30 = until;
  const since30 = addDays(until, -29);
  await page.goto(`${APP}/anuncios`);
  await page.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
  const text = norm(await page.locator("main").innerText());
  check("hay una seccion por moneda (no se suman monedas distintas)", text.includes("Cuentas en USD") && text.includes("Cuentas en COP"));
  check("el gasto de 30 dias en USD coincide con lo esperado", text.includes(norm(money(expectedCents(ACCOUNTS[0], since30, until30), "USD"))), money(expectedCents(ACCOUNTS[0], since30, until30), "USD"));
  check("el gasto de 30 dias en COP coincide con lo esperado", text.includes(norm(money(expectedCents(ACCOUNTS[1], since30, until30), "COP"))));
  check("muestra la comparacion con el periodo anterior", text.includes("vs. periodo anterior"));
  check("lista las campañas", text.includes("Ventas Octubre") && text.includes("Remarketing"));
  check("la tabla por cuenta no aparece si la moneda tiene una sola cuenta", !text.includes("Por cuenta publicitaria"));

  const chart = page.locator("svg[role=img]").first();
  check("hay una grafica accesible", await chart.isVisible());
  const bars = (svg) => svg.locator('path[fill="var(--primary)"]').count();
  check("30 dias = 30 columnas", (await bars(chart)) === 30, String(await bars(chart)));
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  const tip = page.locator("div.pointer-events-none").first();
  await tip.waitFor({ timeout: 3000 });
  check("el tooltip aparece al pasar el cursor, con fecha y gasto", /\d/.test(await tip.innerText()) && (await tip.innerText()).length > 8, norm(await tip.innerText()).replace(/\n/g, " | "));
  await page.mouse.move(5, 5);
  await chart.focus();
  await chart.press("End");
  const live = norm(await page.locator("p.sr-only[aria-live]").first().innerText());
  check("con el teclado (End) se anuncia el ultimo dia", live.includes(String(new Date(`${until30}T00:00:00Z`).getUTCFullYear())) && /\d/.test(live), live);
  await page.getByRole("button", { name: "Ver como tabla" }).first().click();
  check("la vista de tabla lista los 30 dias", (await page.locator("table").first().locator("tbody tr").count()) === 30);
  await page.getByRole("button", { name: "Ver gráfica" }).first().click();

  await page.getByRole("link", { name: "7 días" }).click();
  await page.waitForURL(/dias=7/);
  check("7 dias = 7 columnas", (await bars(page.locator("svg[role=img]").first())) === 7);
  await page.getByRole("link", { name: "90 días" }).click();
  await page.waitForURL(/dias=90/);
  const svg90 = page.locator("svg[role=img]").first();
  check("90 dias cambia a linea con relleno suave (no 90 rayas)", (await bars(svg90)) === 1 && (await svg90.locator('path[stroke="var(--primary)"]').count()) === 1, `relleno=${await bars(svg90)}`);

  await page.getByLabel("Cuenta publicitaria").selectOption({ label: "Tienda Colombia" });
  await page.waitForURL(/cuenta=/);
  const filtered = norm(await page.locator("main").innerText());
  check("el filtro por cuenta deja solo esa cuenta (COP)", !filtered.includes("Cuentas en USD") && filtered.includes(norm(money(expectedCents(ACCOUNTS[1], addDays(until, -89), until), "COP"))));

  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(`${APP}/anuncios`);
    await page.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, "anuncios-claro.png"), fullPage: true });
    await page.goto(`${APP}/cuentas`);
    await page.screenshot({ path: path.join(SHOTS, "cuentas-claro.png"), fullPage: true });
    const dark = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    await dark.addCookies(await ctx.cookies());
    const dp = await dark.newPage();
    await dp.goto(`${APP}/anuncios`);
    await dp.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
    await dp.screenshot({ path: path.join(SHOTS, "anuncios-oscuro.png"), fullPage: true });
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await mob.addCookies(await ctx.cookies());
    const mp = await mob.newPage();
    await mp.goto(`${APP}/anuncios`);
    await mp.getByRole("heading", { name: "Cuentas en USD" }).waitFor();
    await mp.screenshot({ path: path.join(SHOTS, "anuncios-movil.png"), fullPage: true });
    await dark.close();
    await mob.close();
  }

  // ---------------------------------------------------------- 6. sincronizar a mano
  await page.goto(`${APP}/cuentas`);
  const row = (name) => page.locator("tr", { hasText: name });
  const before = Number((await db.sql("SELECT UNIX_TIMESTAMP(lastSyncedAt) t FROM SocialAccount WHERE id=?", [idOf("1001")]))[0].t);
  await new Promise((r) => setTimeout(r, 1100));
  await row("Tienda Principal").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Principal").getByText(/Sincronizado: \d+ registros/).waitFor({ timeout: 20_000 });
  check("'Sincronizar' informa cuantos registros trajo", true);
  const after = Number((await db.sql("SELECT UNIX_TIMESTAMP(lastSyncedAt) t FROM SocialAccount WHERE id=?", [idOf("1001")]))[0].t);
  check("se actualiza la fecha de ultima sincronizacion", after > before);
  check("sincronizar dos veces no duplica filas (reemplaza la ventana)", (await countRows(idOf("1001"))) === 180, String(await countRows(idOf("1001"))));
  check("solo las cuentas publicitarias tienen boton 'Sincronizar'", (await row("Mi Marca").first().getByRole("button", { name: "Sincronizar", exact: true }).count()) === 0);

  // ---------------------------------------------------------- 7. limite de uso de Meta en una cuenta
  fake.setScenario({ insights: "ratelimit1002" });
  await page.getByRole("button", { name: "Sincronizar todas" }).click();
  await page.getByText(/Se sincronizaron 1 de 2\. Con problemas: Tienda Colombia/).waitFor({ timeout: 25_000 });
  check("'Sincronizar todas' avisa cual cuenta fallo y sigue con las demas", true);
  const rl = (await db.sql("SELECT status, lastError FROM SocialAccount WHERE id=?", [idOf("1002")]))[0];
  check("un limite de uso no marca la cuenta como vencida; guarda el motivo", rl.status === "ACTIVE" && /esperar/i.test(rl.lastError ?? ""), `${rl.status} / ${rl.lastError}`);
  check("los datos previos de esa cuenta se conservan", (await countRows(idOf("1002"))) === 180);
  fake.setScenario({ insights: "ok" });

  // ---------------------------------------------------------- 8. token vencido
  fake.setScenario({ tokens: "expired" });
  await page.goto(`${APP}/cuentas`);
  await row("Tienda Principal").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Principal").getByText(/venció o fue revocada/).first().waitFor({ timeout: 20_000 });
  const ex = (await db.sql("SELECT status FROM SocialAccount WHERE id=?", [idOf("1001")]))[0];
  check("Meta dice 'token vencido' (190): la cuenta pasa a VENCIDA", ex.status === "EXPIRED");
  await page.goto(`${APP}/cuentas`);
  check("/cuentas muestra la cuenta como 'Vencida'", await row("Tienda Principal").getByText("Vencida").isVisible());
  await page.goto(`${APP}/anuncios`);
  check("/anuncios avisa que hay que reconectar", await page.getByText(/venció/).first().isVisible());
  // El grafico lo pinta un componente de cliente: se espera a que aparezca en lugar de contarlo nada mas cargar la pagina.
  await page.locator("svg[role=img]").first().waitFor({ timeout: 10_000 }).catch(() => {});
  check("los datos historicos siguen visibles aunque venza la conexion", (await page.locator("svg[role=img]").count()) >= 1);
  fake.setScenario({ tokens: "valid" });
  await page.goto(`${APP}/cuentas`);
  await row("Tienda Principal").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Principal").getByText(/Sincronizado:/).waitFor({ timeout: 20_000 });
  check("si el token vuelve a servir, la cuenta vuelve a ACTIVA", (await db.sql("SELECT status FROM SocialAccount WHERE id=?", [idOf("1001")]))[0].status === "ACTIVE");

  // ---------------------------------------------------------- 9. cancelar / state invalido / permiso faltante
  const accountsBefore = Number((await db.sql("SELECT COUNT(*) c FROM SocialAccount"))[0].c);
  fake.setScenario({ dialog: "deny" });
  await page.goto(`${APP}/cuentas`);
  await page.getByRole("link", { name: "Reconectar Meta" }).click();
  await page.waitForURL(/meta=denied/);
  check("si cancela en Facebook, se avisa y no se guarda nada", (await page.getByText("Cancelaste la conexión en Facebook").isVisible()) && Number((await db.sql("SELECT COUNT(*) c FROM SocialAccount"))[0].c) === accountsBefore);

  fake.setScenario({ dialog: "badstate" });
  await page.goto(`${APP}/cuentas`);
  await page.getByRole("link", { name: "Reconectar Meta" }).click();
  await page.waitForURL(/meta=bad_state/);
  check("un `state` que no coincide se rechaza (proteccion CSRF)", await page.getByText(/expiró o no es válida/).isVisible());
  fake.setScenario({ dialog: "approve" });

  await page.goto(`${APP}/api/meta/callback?code=${encodeURIComponent("GOOD-CODE-123")}&state=inventado`);
  check("llamar al callback directo, sin haber empezado el flujo, se rechaza", /meta=bad_state/.test(page.url()));

  fake.setScenario({ perms: "noads" });
  await page.goto(`${APP}/cuentas`);
  await page.getByRole("link", { name: "Reconectar Meta" }).click();
  await page.waitForURL(/meta=partial/);
  check("si no concede ads_read, avisa que no se podran leer anuncios", /ads_read/.test(await page.getByRole("status").first().innerText()));
  fake.setScenario({ perms: "all" });

  // reconexion buena: no duplica cuentas, y el state de un flujo ya usado no sirve de nuevo
  callbackUrls.length = 0;
  await page.goto(`${APP}/cuentas`);
  await page.getByRole("link", { name: "Reconectar Meta" }).click();
  await page.waitForURL(/meta=connected/);
  check("reconectar no duplica cuentas (actualiza las existentes)", Number((await db.sql("SELECT COUNT(*) c FROM SocialAccount"))[0].c) === accountsBefore);
  const used = callbackUrls.find((u) => u.includes("code="));
  await page.goto(used);
  check("repetir un callback ya usado se rechaza (el state es de un solo uso)", /meta=bad_state/.test(page.url()));

  // ---------------------------------------------------------- 10. desconectar
  await page.goto(`${APP}/cuentas`);
  page.once("dialog", (d) => d.accept());
  await row("Tienda Colombia").getByRole("button", { name: "Desconectar" }).click();
  // La fila pasa a "Desconectada" y deja de mostrar botones (por eso no hay mensaje de exito aparte).
  await row("Tienda Colombia").getByText("Desconectada").waitFor({ timeout: 10_000 });
  const gone = (await db.sql("SELECT status, accessTokenEnc, tokenExpiresAt FROM SocialAccount WHERE id=?", [idOf("1002")]))[0];
  check("desconectar borra el token y marca la cuenta como REVOCADA", gone.status === "REVOKED" && gone.accessTokenEnc === null && gone.tokenExpiresAt === null);
  check("el historial de anuncios se conserva", (await countRows(idOf("1002"))) === 180);
  await page.goto(`${APP}/cuentas`);
  check("la cuenta desconectada ya no ofrece 'Sincronizar'", (await row("Tienda Colombia").getByRole("button").count()) === 0);
  await page.goto(`${APP}/anuncios`);
  check("sus datos siguen apareciendo en Anuncios", (await page.locator("main").innerText()).includes("Cuentas en COP"));

  // ---------------------------------------------------------- 11. secretos y auditoria
  const html = [await (await ctx.request.get(`${APP}/cuentas`)).text(), await (await ctx.request.get(`${APP}/anuncios`)).text(), await (await ctx.request.get(`${APP}/equipo`)).text()].join("\n");
  check("ninguna pantalla contiene el secreto de la app ni tokens", ![APP_SECRET, LONG_TOKEN, PAGE_TOKEN, "accessTokenEnc"].some((s) => html.includes(s)));
  const audits = await db.sql("SELECT action, detail FROM AuditLog");
  const kinds = new Set(audits.map((a) => a.action));
  check("la auditoria registra conexion, sincronizacion, cancelacion, rechazo y desconexion", ["meta.connected", "meta.synced", "ads.synced_all", "meta.connect_denied", "meta.connect_rejected", "meta.disconnected"].every((k) => kinds.has(k)), [...kinds].join(","));
  check("la auditoria no contiene tokens", !JSON.stringify(audits).includes("TOKEN"));
  check("el historial del equipo muestra los eventos de Meta", await (async () => { await page.goto(`${APP}/equipo`); return (await page.getByText("Actividad reciente").isVisible()); })());

  // ---------------------------------------------------------- 11b. muchas cuentas (portafolio comercial) con la base lenta
  // Reproduce el fallo real de la primera conexion con un portafolio: guardar todas las cuentas en una
  // sola transaccion superaba los 5 s de Prisma cuando la base esta lejos. Con E2E_DB_LATENCY_MS (ej. 100)
  // esta comprobacion corre con ~200 ms por consulta, como contra un VPS.
  fake.setScenario({ assets: "bulk" });
  await page.goto(`${APP}/cuentas`);
  const t0 = Date.now();
  await page.getByRole("link", { name: "Reconectar Meta" }).click();
  await page.waitForURL(/\/cuentas\?meta=(connected|partial|error)/, { timeout: 90_000 });
  const took = Date.now() - t0;
  const bulkBanner = await page.getByRole("status").first().innerText().catch(() => "");
  check("con muchas cuentas la conexion termina bien (24 publicitarias, 15 paginas, 4 Instagram)", /24 cuenta\(s\) publicitaria\(s\), 15 página\(s\) de Facebook y 5 cuenta\(s\) de Instagram/.test(bulkBanner) && !/no se pudieron guardar/.test(bulkBanner), `${bulkBanner.slice(0, 110)} (${took} ms)`);
  const byKind = await db.sql("SELECT kind, COUNT(*) c FROM SocialAccount GROUP BY kind");
  const total = (k) => Number(byKind.find((x) => x.kind === k)?.c ?? 0);
  check("se guardaron todas: 24 publicitarias, 15 paginas, 5 Instagram", total("AD_ACCOUNT") === 24 && total("FACEBOOK_PAGE") === 15 && total("INSTAGRAM_PROFILE") === 5, JSON.stringify(byKind, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  check("la cuenta repetida por Meta no se duplica", Number((await db.sql("SELECT COUNT(*) c FROM SocialAccount WHERE externalId='1001'"))[0].c) === 1);
  const longName = (await db.sql("SELECT name FROM SocialAccount WHERE externalId='2005'"))[0];
  check("un nombre de 300 caracteres se recorta al limite de la columna en lugar de fallar", longName?.name?.length === 191, String(longName?.name?.length));
  const bulkAudit = (await db.sql("SELECT detail FROM AuditLog WHERE action='meta.connected' ORDER BY createdAt DESC LIMIT 1"))[0];
  check("el historial no registra cuentas omitidas", !bulkAudit?.detail?.skipped);
  check("se reactivo la cuenta que estaba desconectada", (await db.sql("SELECT status FROM SocialAccount WHERE id=?", [idOf("1002")]))[0].status === "ACTIVE");
  fake.setScenario({ assets: "base" });

  // ---------------------------------------------------------- 12. permisos: solo lectura
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const v = await vctx.newPage();
  await v.goto(`${APP}/login`);
  await v.getByLabel("Correo").fill(VIEWER.email);
  await v.getByLabel("Contraseña", { exact: true }).fill(VIEWER.pass);
  await v.getByRole("button", { name: "Entrar" }).click();
  await v.waitForURL(`${APP}/`);
  await v.goto(`${APP}/cuentas`);
  const vtext = await v.locator("main").innerText();
  check("solo lectura: no ve 'Conectar Meta' ni botones de sincronizar/desconectar", (await v.getByRole("link", { name: /Conectar Meta|Reconectar Meta/ }).count()) === 0 && (await v.getByRole("button", { name: /Sincronizar|Desconectar/ }).count()) === 0 && vtext.includes("Solo un administrador puede conectar cuentas"));
  await v.goto(`${APP}/anuncios`);
  await v.locator("svg[role=img]").first().waitFor({ timeout: 10_000 }); // la grafica se dibuja al cargar el navegador
  check("solo lectura: si puede ver los anuncios", (await v.locator("svg[role=img]").count()) >= 1);
  check("solo lectura: no ve 'Sincronizar todas'", (await v.getByRole("button", { name: "Sincronizar todas" }).count()) === 0);
  const dialogsBefore = fake.requests().filter((r) => r.path === "dialog/oauth").length;
  await v.goto(`${APP}/api/meta/connect`);
  check("solo lectura: /api/meta/connect no lo manda a Facebook", fake.requests().filter((r) => r.path === "dialog/oauth").length === dialogsBefore && v.url().startsWith(APP));
  check("solo lectura: no se creo la cookie de `state`", !(await vctx.cookies()).some((c) => c.name === "redes_meta_state"));

  // ---------------------------------------------------------- 13. Meta sin configurar (segunda instancia)
  await page.goto(`${PLAIN}/cuentas`);
  check("sin META_APP_ID/SECRET se explica que falta configurar", await page.getByText(/Falta crear la app en Meta for Developers/).isVisible());
  check("sin configurar no hay boton de conectar", (await page.getByRole("link", { name: /Conectar Meta|Reconectar Meta/ }).count()) === 0);
  await page.goto(`${PLAIN}/api/meta/connect`);
  check("/api/meta/connect sin configurar vuelve con un aviso claro", /meta=not_configured/.test(page.url()) && (await page.getByText(/faltan META_APP_ID y META_APP_SECRET/).isVisible()));
  await row("Tienda Principal").getByRole("button", { name: "Sincronizar", exact: true }).click();
  await row("Tienda Principal").getByText(/Meta no está configurado en este servidor/).waitFor({ timeout: 10_000 });
  check("sincronizar sin configurar da un error claro, no un fallo", true);

  // ---------------------------------------------------------- 14. manual de Facebook e Instagram (en la propia app)
  await page.goto(`${APP}/cuentas`);
  check("en Cuentas, la tarjeta de Meta enlaza a la guía paso a paso", (await page.getByRole("link", { name: "Guía paso a paso de Facebook e Instagram" }).getAttribute("href")) === "/manual");
  check("el menú tiene «Manual» para el administrador y para solo lectura", (await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Manual" }).count()) === 1 && (await v.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Manual" }).count()) === 1);
  await page.goto(`${APP}/manual`);
  await page.getByRole("heading", { name: "Manual: Facebook e Instagram" }).waitFor();
  const ids = await page.locator("main section[id]").evaluateAll((els) => els.map((e) => e.id));
  check("el manual tiene todas sus secciones con ancla", ["requisitos", "instagram", "crear-app", "servidor", "conectar", "marcas", "publicar-instagram", "permisos", "problemas"].every((id) => ids.includes(id)), ids.join());
  check("cada enlace del índice apunta a una sección que existe", (await page.locator('nav[aria-label="En esta guía"] a').evaluateAll((as, found) => as.every((a) => found.includes(a.getAttribute("href").slice(1))), ids)));
  const manual = norm(await page.locator("main").innerText());
  check("«Tu estado ahora» (solo administradores) lista lo que ve la app: app configurada, páginas, Instagram y permisos", manual.includes("Tu estado ahora") && manual.includes("La app de Meta está configurada en el servidor") && /15 página\(s\) de Facebook conectada\(s\)/.test(manual) && /5 cuenta\(s\) de Instagram conectada\(s\)/.test(manual) && manual.includes("Las cuentas conectadas tienen permiso para publicar"));
  const stepLinks = await page.getByRole("link", { name: "Ver el paso" }).evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check("con la app en localhost avisa que Instagram aún no puede descargar las imágenes, y lleva al paso", manual.includes("Instagram no podrá descargar las imágenes todavía") && stepLinks.includes("#publicar-instagram"), `enlaces: ${stepLinks.join()}`);
  const uriBlock = page.locator("pre", { hasText: `${APP}/api/meta/callback` }).first();
  check("muestra la URI de redirección real de esta app, lista para pegar en Meta", (await uriBlock.innerText()).trim() === `${APP}/api/meta/callback`);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  await uriBlock.locator("xpath=following-sibling::button").click();
  check("el botón «Copiar» copia esa dirección al portapapeles", (await page.evaluate(() => navigator.clipboard.readText())) === `${APP}/api/meta/callback` && (await page.getByText("¡Copiado!").isVisible()));
  check("explica los puntos que costaron trabajo: la ruta «con inicio de sesión de Facebook», no cambiar APP_URL y el JPG/proporción", manual.includes("API setup with Facebook login") && manual.includes("No cambies APP_URL") && manual.includes("4:5") && manual.includes("trycloudflare"));
  check("recoge los mensajes de error reales con su solución", ["Invalid Scopes", "falta pages_manage_posts", "Instagram no pudo descargar la imagen desde tu servidor", "redirect_uri"].every((m) => manual.includes(m)));
  check("el manual no contiene secretos ni tokens", ![APP_SECRET, LONG_TOKEN, PAGE_TOKEN].some((s) => manual.includes(s)));
  await page.locator("details", { hasText: "Invalid Scopes" }).first().locator("summary").click();
  check("cada problema se despliega con su explicación", await page.getByText(/Quita esos nombres de META_SCOPES/).isVisible());
  await v.goto(`${APP}/manual`);
  await v.getByRole("heading", { name: "Manual: Facebook e Instagram" }).waitFor();
  const viewerManual = await v.locator("main").innerText();
  check("solo lectura ve la guía, pero no el estado de configuración del servidor", viewerManual.includes("1. La cuenta de Instagram") && (await v.getByRole("heading", { name: "Tu estado ahora" }).count()) === 0 && !viewerManual.includes("Tu estado ahora") && !viewerManual.includes("Ver el paso"));
  await page.goto(`${PLAIN}/manual`);
  const plainManual = norm(await page.locator("main").innerText());
  check("sin la app de Meta configurada, el estado dice qué falta primero", plainManual.includes("Falta configurar la app de Meta en el servidor") && /Pendiente/.test(plainManual));
  check("si MEDIA_PUBLIC_BASE_URL es la dirección de ejemplo copiada tal cual, lo detecta", plainManual.includes("parece el ejemplo del manual"));

  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(`${APP}/manual`);
    await page.getByRole("heading", { name: "Manual: Facebook e Instagram" }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, "manual-claro.png"), fullPage: true });
    const dark = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    await dark.addCookies(await ctx.cookies());
    const dp = await dark.newPage();
    await dp.goto(`${APP}/manual`);
    await dp.getByRole("heading", { name: "Manual: Facebook e Instagram" }).waitFor();
    await dp.locator("details", { hasText: "Invalid Scopes" }).first().locator("summary").click();
    await dp.screenshot({ path: path.join(SHOTS, "manual-oscuro.png"), fullPage: true });
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await mob.addCookies(await ctx.cookies());
    const mp = await mob.newPage();
    await mp.goto(`${APP}/manual`);
    await mp.getByRole("heading", { name: "Manual: Facebook e Instagram" }).waitFor();
    check("en el móvil el manual no tiene scroll horizontal", await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await mp.screenshot({ path: path.join(SHOTS, "manual-movil.png"), fullPage: true });
    await dark.close();
    await mob.close();
  }

  check("ninguna llamada a Meta salio sin firma valida durante toda la prueba", fake.requests().filter((r) => r.token).every((r) => r.proofOk));
} catch (e) {
  fail("excepción en el recorrido", String(e?.stack ?? e).slice(0, 700));
  console.log("\n--- ultimas lineas de la app ---");
  console.log(logs.slice(-25).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [appA, appB]) child?.kill();
  await fake?.close().catch(() => {});
  await latency?.close().catch(() => {});
}

process.exit(finish());
