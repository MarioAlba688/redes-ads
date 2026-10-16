// Prueba de extremo a extremo de las estadisticas de las publicaciones: lectura automatica por el worker (cifras,
// calendario de relecturas, errores de Meta, permisos que faltan, metricas retiradas), pantalla Estadisticas
// (resumen, filtros, orden, avisos), boton «Actualizar» y permisos por rol, contra un Meta SIMULADO (fake-meta.mjs).
// Arranca la app una vez con el worker encendido (hace falta `npm run build`). VACIA la base de pruebas (*_test).

import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";
import { APP_ID, APP_SECRET, fbStatsFor, igStatsFor, PAGE_TOKEN, startFakeMeta } from "./fake-meta.mjs";
import { createChecker, createDb, findChrome, requireTestDb, startApp, waitFor, waitReady } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_PORT = Number(process.env.E2E_STATS_PORT ?? 3340);
const FAKE_PORT = Number(process.env.E2E_FAKE_META_PORT ?? 4040);
const APP = `http://localhost:${APP_PORT}`;
const SETUP_TOKEN = "codigo-de-prueba-123";
const SHOTS = process.env.E2E_SHOTS_DIR;

const ADMIN = { name: "Mario Alba", email: "mario@example.com", pass: "clave-admin-2026" };
const USERS = {
  edgar: { id: "u-edgar-0001", name: "Edgar Editor", email: "edgar@example.com", pass: "clave-edgar-2026x", role: "EDITOR" },
  aura: { id: "u-aura-00001", name: "Aura Aprobadora", email: "aura@example.com", pass: "clave-aura-2026xx", role: "APPROVER" },
  vera: { id: "u-vera-00001", name: "Vera Lectora", email: "vera@example.com", pass: "clave-vera-2026xx", role: "VIEWER" },
};
const BRAND_RES = "brand-reservi";
const BRAND_SMA = "brand-smartec";
const FULL_SCOPES = "pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_posts,read_insights,instagram_basic,instagram_content_publish,instagram_manage_insights";

const { raw: DB_URL, url: dbUrl } = requireTestDb();
const db = createDb(dbUrl);
const { check, fail, finish } = createChecker();

if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("Falta compilar la app: ejecuta `npm run build` antes de esta prueba.");
  process.exit(2);
}

// ------------------------------------------------------------ utilidades

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
/** Mismo formato que src/lib/crypto.ts: v1.<iv>.<tag>.<texto cifrado> (AES-256-GCM, base64url). */
function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "base64"), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
const tag = () => randomBytes(3).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Formatos iguales a los de la app (src/lib/format.ts): Intl "es".
const num = (v) => new Intl.NumberFormat("es").format(Math.round(v));
const compact = (v) => new Intl.NumberFormat("es", { notation: "compact", maximumFractionDigits: 1 }).format(v);
const pct = (ratio) => `${new Intl.NumberFormat("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ratio * 100)} %`;

/** Cifras que el Meta simulado devuelve para una publicacion (y su interaccion total). */
const fbExp = (n, b = 0) => {
  const s = fbStatsFor(n, b);
  return { views: s.views, reach: s.reach, likes: s.reactions, comments: s.comments, shares: s.shares, saves: null, inter: s.reactions + s.comments + s.shares };
};
const igExp = (n, b = 0) => {
  const s = igStatsFor(n, b);
  return { views: s.views, reach: s.reach, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saved, inter: s.likes + s.comments + s.shares + s.saved };
};
/** Lo que debe mostrar una fila de la tabla: vistas, alcance, reacciones, comentarios, compartidos, guardados, interaccion. */
const rowTexts = (e, kind) => [num(e.views), num(e.reach), num(e.likes), num(e.comments), num(e.shares), kind === "fb" ? "n/a" : num(e.saves), pct(e.inter / e.reach)];

// El Meta simulado numera por el final del id: P-1_10 -> n=10, IGM-4 -> n=4.
const HOURS = 60;
const minutesAgo = (m) => `DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${Number(m)} MINUTE)`;

const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "redes-e2e-stats-media-"));
let counter = 0;

/** Crea una publicacion ya publicada (con sus destinos) directamente en la base. */
async function makePublished({ brand = BRAND_RES, text, ageMinutes, targets, image = false }) {
  const id = `post-${String(++counter).padStart(4, "0")}`;
  text ??= `Publicada ${id} ${tag()}`;
  await db.sql(
    `INSERT INTO Post (id, brandId, text, status, publishedAt, createdById, aiGenerated, createdAt, updatedAt) VALUES (?, ?, ?, 'PUBLISHED', ${minutesAgo(ageMinutes)}, ?, 0, NOW(3), NOW(3))`,
    [id, brand, text, USERS.edgar.id],
  );
  if (image) {
    const storageKey = `${randomBytes(24).toString("hex")}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, storageKey), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await db.sql(
      "INSERT INTO PostMedia (id, postId, mimeType, size, width, height, storageKey, originalName, position, createdAt) VALUES (?, ?, 'image/jpeg', 4, 1080, 1350, ?, 'foto.jpg', 0, NOW(3))",
      [`${id}-m`, id, storageKey],
    );
  }
  // Los destinos van al final: con el worker corriendo, se leen en cuanto existen.
  const ids = {};
  for (const t of targets) {
    const tid = `${id}-${t.account}`;
    ids[t.account] = tid;
    await db.sql(
      `INSERT INTO PostTarget (id, postId, accountId, status, attempts, externalId, externalUrl, publishedAt) VALUES (?, ?, ?, 'PUBLISHED', 1, ?, ?, ${minutesAgo(ageMinutes)})`,
      [tid, id, t.account, t.externalId, `https://www.example-red.test/${t.externalId}`],
    );
  }
  return { id, text, targets: ids };
}

const metricsOf = async (targetId) => {
  const r = (await db.sql(
    "SELECT views, reach, likes, comments, shares, saves, note, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(3), nextFetchAt) AS nextIn, nextFetchAt IS NULL AS noNext, TIMESTAMPDIFF(SECOND, fetchedAt, UTC_TIMESTAMP(3)) AS age FROM PostTargetMetrics WHERE targetId=?",
    [targetId],
  ))[0];
  if (!r) return null;
  return { ...r, nextIn: r.nextIn === null ? null : Number(r.nextIn), age: Number(r.age), noNext: Number(r.noNext) === 1 };
};
const waitMetrics = (targetId, pred = () => true, timeout = 30_000) =>
  waitFor(async () => {
    const m = await metricsOf(targetId);
    return m && pred(m) ? m : null;
  }, { timeout, interval: 300 });
/** Hace que el worker vuelva a leer ese destino en su proxima vuelta. */
const dueNow = (targetId) => db.sql(`UPDATE PostTargetMetrics SET nextFetchAt = ${minutesAgo(1)} WHERE targetId=?`, [targetId]);
const metricsCount = async () => Number((await db.sql("SELECT COUNT(*) c FROM PostTargetMetrics"))[0].c);

let fake;
let appA;
let browser;
const logs = [];
try {
  await db.reset();
  fake = await startFakeMeta(FAKE_PORT, `${APP}/api/meta/callback`);
  const calm = () => fake.setScenario({ stats: "ok", statsBoost: 0, tokens: "valid", publishFail: {}, flaky: {} });
  const statsCalls = (pred = () => true) => fake.requests().filter((r) => /^(P-[A-Za-z0-9]+_\d+|IGM-\d+)(\/insights)?$/.test(r.path) && pred(r));

  appA = startApp({
    root: ROOT,
    port: APP_PORT,
    logs,
    env: {
      DATABASE_URL: DB_URL,
      SETUP_TOKEN,
      ENCRYPTION_KEY,
      E2E_DATABASE_URL: "",
      META_APP_ID: APP_ID,
      META_APP_SECRET: APP_SECRET,
      META_API_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      META_SCOPES: "",
      META_LOGIN_CONFIG_ID: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "",
      MEDIA_DIR,
      APP_URL: APP,
      MEDIA_PUBLIC_BASE_URL: "",
      WORKER_ENABLED: "true",
      WORKER_INTERVAL_SECONDS: "1",
      TZ: "UTC",
      APP_TIMEZONE: "",
    },
  });
  await waitReady(APP);

  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const contexts = [];
  const newPage = async (viewport = { width: 1280, height: 1000 }, extra = {}) => {
    const ctx = await browser.newContext({ viewport, ...extra });
    contexts.push(ctx);
    return { ctx, page: await ctx.newPage() };
  };
  const loginAs = async (page, u) => {
    await page.goto(`${APP}/login`);
    await page.getByLabel("Correo").fill(u.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(u.pass);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL(`${APP}/`);
  };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  };
  const postRows = (page) => page.getByRole("table", { name: "Publicaciones con sus estadísticas" }).locator("tbody tr");
  const tableRow = (page, text) => postRows(page).filter({ hasText: text });
  const cellTexts = async (row) => (await row.locator("td").allInnerTexts()).slice(1).map((s) => s.trim());
  const tile = (page, label) => page.locator("main p").filter({ hasText: new RegExp(`^${label}$`) }).first().locator("xpath=following-sibling::p[1]");
  const STATS = `${APP}/estadisticas`;

  // ------------------------------------------------------------ 0. instalacion, usuarios, marcas y cuentas
  const { ctx: adminCtx, page: admin } = await newPage();
  await admin.goto(`${APP}/setup`);
  await admin.getByLabel("Código de instalación").fill(SETUP_TOKEN);
  await admin.getByLabel("Tu nombre").fill(ADMIN.name);
  await admin.getByLabel("Correo").fill(ADMIN.email);
  await admin.getByLabel("Contraseña", { exact: true }).fill(ADMIN.pass);
  await admin.getByLabel("Repite la contraseña").fill(ADMIN.pass);
  await admin.getByRole("button", { name: "Crear administrador" }).click();
  await admin.waitForURL(`${APP}/`);
  check("administrador creado", true);

  for (const u of Object.values(USERS)) {
    await db.sql("INSERT INTO User (id, email, name, passwordHash, role, active, failedLogins, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 0, NOW(3), NOW(3))", [
      u.id, u.email, u.name, bcrypt.hashSync(u.pass, 4), u.role,
    ]);
  }
  for (const [id, name] of [[BRAND_RES, "Reservi"], [BRAND_SMA, "Smartec"]]) {
    await db.sql("INSERT INTO Brand (id, name, description, language, timezone, createdAt, updatedAt) VALUES (?, ?, 'Negocio de prueba.', 'es', 'America/Bogota', NOW(3), NOW(3))", [id, name]);
  }
  const account = (id, kind, ext, name, token, brandId, scopes = FULL_SCOPES) =>
    db.sql(
      "INSERT INTO SocialAccount (id, platform, kind, externalId, name, status, accessTokenEnc, scopes, brandId, createdAt, updatedAt) VALUES (?, 'META', ?, ?, ?, 'ACTIVE', ?, ?, ?, NOW(3), NOW(3))",
      [id, kind, ext, name, encrypt(token), scopes, brandId],
    );
  await account("acc-fb-reservi", "FACEBOOK_PAGE", "P-1", "Mi Marca", PAGE_TOKEN, BRAND_RES);
  await account("acc-ig-reservi", "INSTAGRAM_PROFILE", "IG-1", "Mi Marca Oficial", PAGE_TOKEN, BRAND_RES);
  await account("acc-fb-smartec", "FACEBOOK_PAGE", "P-2", "Smartec", "PAGE-TOKEN-2222", BRAND_SMA);

  const anon = await fetch(STATS, { redirect: "manual" });
  check("sin sesión, /estadisticas manda a iniciar sesión", [302, 303, 307, 308].includes(anon.status) && (anon.headers.get("location") ?? "").includes("/login"), String(anon.status));

  // ------------------------------------------------------------ 1. el worker lee lo ya publicado
  // p1: Facebook + Instagram, publicada hace 2 h. p2: hace 3 dias. p3 (otra marca): hace 10 dias.
  // p-vieja: hace 120 dias (fuera de los 90). Un destino fallido y un borrador no cuentan.
  const p1 = await makePublished({ text: `Reservas sin llamadas ${tag()}`, ageMinutes: 2 * HOURS, image: true, targets: [{ account: "acc-fb-reservi", externalId: "P-1_10" }, { account: "acc-ig-reservi", externalId: "IGM-4" }] });
  const p2 = await makePublished({ text: `Promo de la semana ${tag()}`, ageMinutes: 3 * 24 * HOURS, targets: [{ account: "acc-fb-reservi", externalId: "P-1_21" }] });
  const p3 = await makePublished({ brand: BRAND_SMA, text: `Lanzamiento Smartec ${tag()}`, ageMinutes: 10 * 24 * HOURS, targets: [{ account: "acc-fb-smartec", externalId: "P-2_7" }] });
  const pOld = await makePublished({ text: `Publicación antigua ${tag()}`, ageMinutes: 120 * 24 * HOURS, targets: [{ account: "acc-fb-reservi", externalId: "P-1_5" }] });
  await db.sql("INSERT INTO Post (id, brandId, text, status, createdById, aiGenerated, createdAt, updatedAt) VALUES ('post-borrador', ?, 'Solo un borrador', 'DRAFT', ?, 0, NOW(3), NOW(3))", [BRAND_RES, USERS.edgar.id]);
  await db.sql("INSERT INTO PostTarget (id, postId, accountId, status, attempts, error) VALUES ('t-fallido', 'post-borrador', 'acc-fb-reservi', 'FAILED', 1, 'x')");

  const t = { fb1: p1.targets["acc-fb-reservi"], ig1: p1.targets["acc-ig-reservi"], fb2: p2.targets["acc-fb-reservi"], fb3: p3.targets["acc-fb-smartec"], old: pOld.targets["acc-fb-reservi"] };
  const read = await Promise.all([t.fb1, t.ig1, t.fb2, t.fb3].map((id) => waitMetrics(id)));
  check("el worker leyó las 4 publicaciones recientes sin que nadie lo pidiera", read.every(Boolean));

  const same = (m, e) => m.views === e.views && m.reach === e.reach && m.likes === e.likes && m.comments === e.comments && m.shares === e.shares && m.saves === e.saves;
  check("Facebook: vistas, alcance, reacciones, comentarios y compartidos guardados tal cual los dio Meta", same(read[0], fbExp(10)), JSON.stringify(read[0]));
  check("Instagram: vistas, alcance, me gusta, comentarios, compartidos y guardados guardados tal cual", same(read[1], igExp(4)), JSON.stringify(read[1]));
  check("Facebook no manda `shares` cuando nadie compartió: queda en 0, no sin dato", read[2].shares === 0 && same(read[2], fbExp(21)), JSON.stringify(read[2]));
  check("sin avisos cuando Meta entrega todo", read.every((m) => m.note === null));

  check("la antigua (120 días), el destino fallido y el borrador no se leen", (await metricsOf(t.old)) === null && (await metricsOf("t-fallido")) === null);
  // Calendario de relecturas: cada 3 h los primeros 2 dias, cada 12 h hasta las dos semanas.
  check("la de hace 2 h se volverá a leer en ~3 h", read[0].nextIn >= 178 && read[0].nextIn <= 180, String(read[0].nextIn));
  check("la de hace 3 días, en ~12 h; la de hace 10 días también", read[2].nextIn >= 718 && read[2].nextIn <= 720 && read[3].nextIn >= 718 && read[3].nextIn <= 720, `${read[2].nextIn} / ${read[3].nextIn}`);

  const first = statsCalls();
  check("por cada destino, una lectura de la publicación y una de sus insights", first.length === 8 && ["P-1_10", "P-1_10/insights", "IGM-4", "IGM-4/insights", "P-1_21", "P-1_21/insights", "P-2_7", "P-2_7/insights"].every((p) => first.some((r) => r.path === p)), first.map((r) => r.path).join(","));
  check("Facebook pide las métricas vigentes (vistas y alcance), no las «impresiones» retiradas", statsCalls((r) => r.path === "P-1_10/insights").length === 1 && !JSON.stringify(first).includes("impressions"));
  await sleep(3500);
  check("sin nada vencido, el worker no vuelve a llamar a Meta", statsCalls().length === 8 && (await metricsCount()) === 4);

  // ------------------------------------------------------------ 2. la pantalla Estadisticas (el administrador ya tiene sesion desde /setup)
  await admin.goto(STATS);
  await admin.getByRole("heading", { name: "Estadísticas" }).waitFor();
  check("el menú tiene «Estadísticas»", await admin.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Estadísticas" }).isVisible());

  const rowFb1 = tableRow(admin, `${p1.text.slice(0, 20)}`).filter({ hasText: "Facebook Mi Marca" });
  const rowIg1 = tableRow(admin, p1.text.slice(0, 20)).filter({ hasText: "Instagram Mi Marca Oficial" });
  const rowFb2 = tableRow(admin, p2.text);
  const rowFb3 = tableRow(admin, p3.text);
  check("la tabla lista las 4 publicaciones (y no la antigua, el fallido ni el borrador)", (await postRows(admin).count()) === 4 && (await tableRow(admin, "antigua").count()) === 0 && (await tableRow(admin, "borrador").count()) === 0);
  check("fila de Facebook con sus cifras", JSON.stringify(await cellTexts(rowFb1)) === JSON.stringify(rowTexts(fbExp(10), "fb")), JSON.stringify(await cellTexts(rowFb1)));
  check("fila de Instagram con sus cifras (incluye guardados)", JSON.stringify(await cellTexts(rowIg1)) === JSON.stringify(rowTexts(igExp(4), "ig")), JSON.stringify(await cellTexts(rowIg1)));
  check("fila de Facebook sin compartidos: muestra 0 y «n/a» en guardados", JSON.stringify(await cellTexts(rowFb2)) === JSON.stringify(rowTexts(fbExp(21), "fb")));
  check("la fila lleva el enlace a la red social y a la publicación, y la miniatura de su imagen", (await rowFb1.getByRole("link", { name: "Ver en Facebook" }).getAttribute("href")) === "https://www.example-red.test/P-1_10" && (await rowFb1.getByRole("link").first().getAttribute("href")) === `/publicaciones/${p1.id}` && /^\/media\/[a-f0-9]{48}\.jpg$/.test((await rowFb1.locator("img").getAttribute("src")) ?? ""));

  const all = [fbExp(10), igExp(4), fbExp(21), fbExp(7)];
  const sum = (k) => all.reduce((a, e) => a + e[k], 0);
  check("tarjeta de publicaciones: 4, todas con cifras", (await tile(admin, "Publicaciones").innerText()) === "4");
  check("tarjeta de vistas = suma de las 4", (await tile(admin, "Vistas").innerText()) === compact(sum("views")), await tile(admin, "Vistas").innerText());
  check("tarjeta de alcance medio = promedio por publicación (el alcance no se suma)", (await tile(admin, "Alcance medio").innerText()) === compact(Math.round(sum("reach") / 4)));
  check("tarjeta de interacciones = reacciones + comentarios + compartidos + guardados", (await tile(admin, "Interacciones").innerText()) === compact(sum("inter")));
  check("interacción por alcance = interacciones totales / alcance total", (await tile(admin, "Interacción por alcance").innerText()) === pct(sum("inter") / sum("reach")), await tile(admin, "Interacción por alcance").innerText());
  check("la mejor publicación es la de más interacciones", (await admin.locator("main").getByText("Mejor publicación").locator("xpath=..").innerText()).includes(p2.text));
  check("hay gráfico de barras con las mejores publicaciones", (await admin.locator("main li").filter({ hasText: p2.text.slice(0, 15) }).count()) >= 1);
  check("con dos redes y dos marcas se ofrecen los resúmenes por red y por marca", (await admin.getByRole("heading", { name: "Por red social" }).count()) === 1 && (await admin.getByRole("heading", { name: "Por marca" }).count()) === 1);
  check("por defecto, las que más interacciones tienen van primero", (await postRows(admin).first().innerText()).includes(p2.text));
  await shot(admin, "estadisticas-claro.png");

  // Filtros y orden
  await admin.goto(`${STATS}?red=instagram`);
  check("filtrar por Instagram deja solo esa publicación", (await postRows(admin).count()) === 1 && (await rowIg1.count()) === 1);
  await admin.goto(`${STATS}?dias=7`);
  check("con 7 días no aparece la de hace 10 días", (await postRows(admin).count()) === 3 && (await rowFb3.count()) === 0);
  await admin.goto(`${STATS}?marca=${BRAND_SMA}`);
  check("filtrar por marca deja solo las de esa marca (y ya no hay resumen por marca)", (await postRows(admin).count()) === 1 && (await rowFb3.count()) === 1 && (await admin.getByRole("heading", { name: "Por marca" }).count()) === 0);
  await admin.goto(`${STATS}?marca=${BRAND_SMA}&dias=7`);
  check("sin publicaciones en el periodo se explica y no hay tabla", (await admin.getByText("Aún no hay publicaciones en este periodo").count()) === 1 && (await postRows(admin).count()) === 0);
  await admin.goto(`${STATS}?dias=abc&marca=ajena&red=tiktok&orden=inventado`);
  check("filtros inválidos en la dirección se ignoran (30 días, todo)", (await postRows(admin).count()) === 4);
  await admin.goto(`${STATS}?orden=recientes`);
  const recent = await postRows(admin).allInnerTexts();
  check("ordenar por más recientes: la de hace 2 h primero y la de hace 10 días al final", recent[0].includes(p1.text.slice(0, 20)) && recent[3].includes(p3.text));
  await admin.goto(`${STATS}?orden=alcance`);
  check("ordenar por mayor alcance", (await postRows(admin).first().innerText()).includes(p2.text));
  const selectBrand = await admin.getByLabel("Marca", { exact: true }).count();
  check("hay selector de marca (hay más de una)", selectBrand === 1);

  // La ficha de la publicacion
  await admin.goto(`${APP}/publicaciones/${p1.id}`);
  const fichaText = await admin.locator("main").innerText();
  check("la ficha de la publicación resume las cifras de cada destino y enlaza a Estadísticas", fichaText.includes(`${num(fbExp(10).views)} vistas`) && fichaText.includes(`${num(fbExp(10).inter)} interacciones`) && fichaText.includes(`${num(igExp(4).inter)} interacciones`) && (await admin.getByRole("link", { name: "Ver estadísticas" }).count()) === 2);

  // ------------------------------------------------------------ 3. «Actualizar»
  const { page: edgar } = await newPage();
  await loginAs(edgar, USERS.edgar);
  await edgar.goto(STATS);
  const callsBefore = statsCalls().length;
  fake.setScenario({ statsBoost: 100 });
  await edgar.getByRole("button", { name: "Actualizar" }).click();
  await edgar.getByText("Todo estaba al día").waitFor();
  check("«Actualizar» no vuelve a leer lo que se leyó hace menos de 2 minutos", statsCalls().length === callsBefore);

  await db.sql(`UPDATE PostTargetMetrics SET fetchedAt = ${minutesAgo(10)}`);
  await edgar.getByRole("button", { name: "Actualizar" }).click();
  await edgar.getByText("Se actualizaron 4 publicaciones.").waitFor();
  const boosted = await Promise.all([t.fb1, t.ig1, t.fb2, t.fb3].map(metricsOf));
  check("con «Actualizar» las 4 publicaciones traen las cifras nuevas", same(boosted[0], fbExp(10, 100)) && same(boosted[1], igExp(4, 100)) && same(boosted[2], fbExp(21, 100)) && same(boosted[3], fbExp(7, 100)), JSON.stringify(boosted[0]));
  check("y la pantalla las muestra", JSON.stringify(await cellTexts(tableRow(edgar, p1.text.slice(0, 20)).filter({ hasText: "Facebook Mi Marca" }))) === JSON.stringify(rowTexts(fbExp(10, 100), "fb")));
  check("quedó en la auditoría quién actualizó y cuántas", (await db.sql("SELECT detail FROM AuditLog WHERE action='stats.refreshed'")).some((r) => JSON.stringify(r.detail).includes('"refreshed":4')));

  const { page: vera } = await newPage();
  await loginAs(vera, USERS.vera);
  await vera.goto(STATS);
  await vera.getByRole("heading", { name: "Estadísticas" }).waitFor();
  check("solo lectura ve las estadísticas pero no el botón «Actualizar»", (await vera.getByRole("button", { name: "Actualizar" }).count()) === 0 && (await postRows(vera).count()) === 4);
  const { page: aura } = await newPage();
  await loginAs(aura, USERS.aura);
  await aura.goto(STATS);
  check("quien aprueba sí puede actualizar", (await aura.getByRole("button", { name: "Actualizar" }).count()) === 1);

  // ------------------------------------------------------------ 4. cuando Meta falla (el worker conserva lo bueno y lo explica)
  // Con cifras nuevas (200) solo en lo que si llega: demuestra que lo que falla conserva la lectura anterior.
  fake.setScenario({ statsBoost: 200, stats: "noinsights" });
  await dueNow(t.fb2);
  const noIns = await waitMetrics(t.fb2, (m) => m.note !== null);
  check("sin permiso de insights: se guardan las reacciones nuevas y se conservan las vistas y el alcance anteriores", noIns.likes === fbExp(21, 200).likes && noIns.views === fbExp(21, 100).views && noIns.reach === fbExp(21, 100).reach, JSON.stringify(noIns));
  check("y se explica qué permiso falta, sin reintentar pronto (12 h)", /read_insights/.test(noIns.note) && noIns.nextIn >= 718 && noIns.nextIn <= 720, `${noIns.note} / ${noIns.nextIn}`);
  await admin.goto(STATS);
  check("la pantalla muestra el aviso de esa publicación", (await tableRow(admin, p2.text).innerText()).includes("read_insights"));

  fake.setScenario({ stats: "badmetric", statsBoost: 300 });
  await dueNow(t.fb3);
  const bad = await waitMetrics(t.fb3, (m) => m.note !== null);
  check("si Meta retira una métrica, las demás cifras siguen llegando y el aviso nombra la que falta", bad.views === fbExp(7, 300).views && bad.likes === fbExp(7, 300).likes && bad.reach === fbExp(7, 100).reach && /alcance/.test(bad.note), JSON.stringify(bad));

  fake.setScenario({ stats: "ratelimit", statsBoost: 300 });
  await dueNow(t.ig1);
  const rate = await waitMetrics(t.ig1, (m) => m.note !== null);
  check("con límite de uso de Meta se guarda lo básico y se reintenta pronto (~30 min)", rate.likes === igExp(4, 300).likes && /exceso de consultas/.test(rate.note) && rate.nextIn >= 28 && rate.nextIn <= 30, `${rate.note} / ${rate.nextIn}`);

  fake.setScenario({ stats: "gone" });
  await dueNow(t.fb1);
  const gone = await waitMetrics(t.fb1, (m) => m.note !== null);
  check("si Meta ya no encuentra la publicación, se conservan sus cifras y se anota (reintento en 24 h)", /no encuentra/.test(gone.note) && gone.views === fbExp(10, 100).views && gone.nextIn >= 1438 && gone.nextIn <= 1440, `${gone.note} / ${gone.nextIn}`);

  fake.setScenario({ stats: "ok", statsBoost: 400, tokens: "expired" });
  await dueNow(t.fb2);
  const expired = await waitMetrics(t.fb2, (m) => /venció/.test(m.note ?? ""));
  check("con la conexión vencida se anota y se reintenta en 1 h", expired.nextIn >= 58 && expired.nextIn <= 60, String(expired.nextIn));
  const acc = (await db.sql("SELECT status FROM SocialAccount WHERE id='acc-fb-reservi'"))[0];
  check("la cuenta queda como «Vencida», igual que al publicar", acc.status === "EXPIRED");
  await admin.goto(STATS);
  check("la pantalla avisa que la conexión venció y enlaza a Cuentas", (await admin.getByText(/La conexión de Mi Marca venció/).count()) === 1 && (await admin.getByRole("link", { name: "Reconéctala en Cuentas" }).getAttribute("href")) === "/cuentas");
  const callsExpired = statsCalls().length;
  await sleep(2500);
  check("mientras la cuenta está vencida el worker no la consulta", statsCalls().length === callsExpired);

  // Se reconecta y todo vuelve a la normalidad (el aviso se limpia).
  fake.setScenario({ tokens: "valid", stats: "ok", statsBoost: 400 });
  await db.sql("UPDATE SocialAccount SET status='ACTIVE', lastError=NULL WHERE id='acc-fb-reservi'");
  await dueNow(t.fb2);
  const healed = await waitMetrics(t.fb2, (m) => m.note === null && m.age < 10);
  check("al reconectar se vuelve a leer sola y desaparece el aviso", same(healed, fbExp(21, 400)), JSON.stringify(healed));
  await dueNow(t.fb1);
  await dueNow(t.ig1);
  await dueNow(t.fb3);
  const healedAll = await Promise.all([t.fb1, t.ig1, t.fb3].map((id) => waitMetrics(id, (m) => m.note === null && m.age < 10)));
  check("lo mismo con las demás publicaciones que habían quedado con aviso", healedAll.every(Boolean));

  // ------------------------------------------------------------ 5. permisos que faltan en la conexion
  calm();
  await db.sql("UPDATE SocialAccount SET scopes='pages_read_engagement,pages_read_user_content,pages_manage_posts' WHERE id='acc-fb-smartec'");
  const p5 = await makePublished({ brand: BRAND_SMA, text: `Sin insights ${tag()}`, ageMinutes: 30, targets: [{ account: "acc-fb-smartec", externalId: "P-2_8" }] });
  const noScope = await waitMetrics(p5.targets["acc-fb-smartec"]);
  check("sin read_insights en la conexión, no se llama a insights (y se leen las reacciones)", statsCalls((r) => r.path === "P-2_8/insights").length === 0 && statsCalls((r) => r.path === "P-2_8").length === 1 && noScope.likes === fbExp(8).likes && noScope.views === null && noScope.reach === null);
  check("la nota nombra el permiso y los pasos para arreglarlo", /read_insights/.test(noScope.note) && /Reconectar Meta/.test(noScope.note), noScope.note);

  await db.sql("UPDATE SocialAccount SET scopes='instagram_content_publish' WHERE id='acc-ig-reservi'");
  const p6 = await makePublished({ text: `Sin permisos de Instagram ${tag()}`, ageMinutes: 20, targets: [{ account: "acc-ig-reservi", externalId: "IGM-12" }] });
  const noBasic = await waitMetrics(p6.targets["acc-ig-reservi"]);
  check("sin instagram_basic no se hace ninguna llamada a Meta para esa publicación", statsCalls((r) => r.path.startsWith("IGM-12")).length === 0 && noBasic.views === null && noBasic.likes === null && /instagram_basic/.test(noBasic.note), noBasic.note);

  await admin.goto(STATS);
  check("la pantalla avisa de las cuentas sin permiso de insights y de las que no pueden leer nada", (await admin.getByText(/Estas cuentas no tienen el permiso read_insights.*Smartec/).count()) === 1 && (await admin.getByText(/Estas cuentas no tienen el permiso para leer estadísticas.*Mi Marca Oficial/).count()) === 1);
  check("los avisos enlazan al Manual", (await admin.getByRole("link", { name: "Ver cómo arreglarlo" }).count()) === 2 && (await admin.getByRole("link", { name: "Ver cómo arreglarlo" }).first().getAttribute("href")) === "/manual#estadisticas");
  const rowNoRead = tableRow(admin, p6.text);
  check("una publicación sin ninguna cifra se muestra «Aún sin leer», con guiones, no con ceros", (await rowNoRead.getByText("Aún sin leer").count()) === 1 && JSON.stringify((await cellTexts(rowNoRead)).slice(0, 4)) === JSON.stringify(["—", "—", "—", "—"]));
  await shot(admin, "estadisticas-avisos.png");

  // El Manual explica el paso y su estado ahora enlaza a él.
  await admin.goto(`${APP}/manual`);
  const manualStats = admin.locator("#estadisticas");
  check("el Manual tiene la sección de estadísticas, enlazada desde su índice", (await manualStats.getByRole("heading", { name: "7. Estadísticas de las publicaciones" }).count()) === 1 && (await admin.locator('nav[aria-label="En esta guía"] a[href="#estadisticas"]').count()) === 1);
  check("«Tu estado ahora» avisa de las cuentas sin permiso de estadísticas y lleva al paso", (await admin.getByText(/cuenta\(s\) conectada\(s\) sin permiso para leer estadísticas/).count()) === 1 && (await admin.locator('#estado-titulo').locator("xpath=ancestor::section").locator('a[href="#estadisticas"]').count()) === 1);
  check("la sección cita los permisos y la línea de META_SCOPES recomendada los incluye", /read_insights/.test(await manualStats.innerText()) && (await admin.getByText(/META_SCOPES="[^"]*instagram_manage_insights"/).count()) >= 1);

  await db.sql("UPDATE SocialAccount SET scopes=? WHERE id IN ('acc-ig-reservi','acc-fb-smartec')", [FULL_SCOPES]);
  await db.sql(`UPDATE PostTargetMetrics SET nextFetchAt = ${minutesAgo(1)} WHERE targetId IN (?, ?)`, [p5.targets["acc-fb-smartec"], p6.targets["acc-ig-reservi"]]);
  const fixed = await Promise.all([p5.targets["acc-fb-smartec"], p6.targets["acc-ig-reservi"]].map((id) => waitMetrics(id, (m) => m.note === null && m.views !== null)));
  check("al arreglar los permisos, la lectura siguiente trae todo y quita el aviso", same(fixed[0], fbExp(8)) && same(fixed[1], igExp(12)), JSON.stringify(fixed));

  // Facebook sin pages_read_user_content: el caso REAL de la primera lectura con una cuenta de verdad. Meta rechaza con
  // «(#10) This endpoint requires the 'pages_read_user_content' permission» toda lectura que pida reacciones o comentarios.
  fake.setScenario({ stats: "nousercontent" });
  await db.sql("UPDATE SocialAccount SET scopes='pages_read_engagement,read_insights,pages_manage_posts' WHERE id='acc-fb-smartec'");
  const p8 = await makePublished({ brand: BRAND_SMA, text: `Sin contenido de usuarios ${tag()}`, ageMinutes: 25, targets: [{ account: "acc-fb-smartec", externalId: "P-2_9" }] });
  const t8 = p8.targets["acc-fb-smartec"];
  const noContent = await waitMetrics(t8);
  check("sabiendo que falta pages_read_user_content no se intenta leer reacciones ni comentarios (una sola lectura de la publicación)", statsCalls((r) => r.path === "P-2_9").length === 1 && statsCalls((r) => r.path === "P-2_9/insights").length === 1);
  check("las reacciones salen del desglose de los insights, los comentarios quedan sin dato (no 0) y compartidos, vistas y alcance llegan", noContent.likes === fbExp(9).likes && noContent.comments === null && noContent.shares === fbExp(9).shares && noContent.views === fbExp(9).views && noContent.reach === fbExp(9).reach, JSON.stringify(noContent));
  check("el aviso nombra el permiso y los pasos", /pages_read_user_content/.test(noContent.note ?? "") && /Reconectar Meta/.test(noContent.note ?? ""), String(noContent.note));
  await admin.goto(STATS);
  check("la pantalla avisa de las páginas sin ese permiso y la fila muestra «—» en comentarios", (await admin.getByText(/Estas páginas no tienen el permiso pages_read_user_content.*Smartec/).count()) === 1 && (await cellTexts(tableRow(admin, p8.text)))[3] === "—");

  // Sin conocer los permisos (conexión antigua sin lista), el error de Meta no tumba la lectura: se sigue sin reacciones ni comentarios.
  await db.sql("UPDATE SocialAccount SET scopes=NULL WHERE id='acc-fb-smartec'");
  const p9 = await makePublished({ brand: BRAND_SMA, text: `Permisos sin conocer ${tag()}`, ageMinutes: 15, targets: [{ account: "acc-fb-smartec", externalId: "P-2_10" }] });
  const t9 = p9.targets["acc-fb-smartec"];
  const unknownScopes = await waitMetrics(t9);
  check("sin conocer los permisos, el (#10) de Meta no tumba la lectura: reintenta sin reacciones ni comentarios", statsCalls((r) => r.path === "P-2_10").length === 2 && unknownScopes.likes === fbExp(10).likes && unknownScopes.comments === null && unknownScopes.views === fbExp(10).views, JSON.stringify(unknownScopes));
  check("y lo explica con el permiso que falta", /pages_read_user_content/.test(unknownScopes.note ?? "") && /comentarios/.test(unknownScopes.note ?? ""), String(unknownScopes.note));

  // Al conceder el permiso (y reconectar), la lectura siguiente trae los comentarios y el aviso desaparece.
  calm();
  await db.sql("UPDATE SocialAccount SET scopes=? WHERE id='acc-fb-smartec'", [FULL_SCOPES]);
  await db.sql(`UPDATE PostTargetMetrics SET nextFetchAt = ${minutesAgo(1)} WHERE targetId IN (?, ?)`, [t8, t9]);
  const withContent = await Promise.all([t8, t9].map((id) => waitMetrics(id, (m) => m.note === null && m.comments !== null && m.age < 10)));
  check("con el permiso concedido llegan los comentarios y las reacciones directas, sin avisos", same(withContent[0], fbExp(9)) && same(withContent[1], fbExp(10)), JSON.stringify(withContent));

  // Instagram oculta los "me gusta": sin dato, no 0.
  fake.setScenario({ stats: "hidelikes" });
  const p7 = await makePublished({ text: `Sin me gusta ${tag()}`, ageMinutes: 10, targets: [{ account: "acc-ig-reservi", externalId: "IGM-9" }] });
  const hidden = await waitMetrics(p7.targets["acc-ig-reservi"]);
  await admin.goto(STATS);
  const hiddenRow = await cellTexts(tableRow(admin, p7.text));
  check("si Instagram oculta los «me gusta», se muestra «—» (no 0) y las demás cifras siguen", hidden.likes === null && hidden.comments === igExp(9).comments && hiddenRow[2] === "—" && hiddenRow[3] === num(igExp(9).comments), JSON.stringify(hiddenRow));
  calm();

  // ------------------------------------------------------------ 6. secretos, errores y diseno
  const secrets = (await db.sql("SELECT accessTokenEnc FROM SocialAccount")).map((r) => r.accessTokenEnc).concat([PAGE_TOKEN, "PAGE-TOKEN-2222", APP_SECRET, "accessTokenEnc"]);
  const html = [];
  for (const u of ["/estadisticas", `/publicaciones/${p1.id}`, "/manual"]) html.push(await (await adminCtx.request.get(`${APP}${u}`)).text());
  check("ninguna pantalla contiene tokens ni secretos", !secrets.some((s) => html.join("\n").includes(s)));
  check("la auditoría no contiene tokens", !JSON.stringify(await db.sql("SELECT detail FROM AuditLog")).includes(PAGE_TOKEN));
  check("el worker no registró errores internos en toda la prueba", !logs.some((l) => /error interno|fallo la vuelta|fallo una vuelta|fallo al leer/.test(l)), logs.filter((l) => /error interno|fallo la vuelta|fallo una vuelta|fallo al leer/.test(l)).slice(0, 3).join(" | "));

  const { page: mob } = await newPage({ width: 390, height: 844 }, { deviceScaleFactor: 2 });
  await loginAs(mob, ADMIN);
  await mob.goto(STATS);
  await mob.getByRole("heading", { name: "Estadísticas" }).waitFor();
  check("en el móvil la página no tiene scroll horizontal (las tablas se desplazan por dentro)", await mob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(mob, "estadisticas-movil.png");
  const { page: dark } = await newPage({ width: 1280, height: 1000 }, { colorScheme: "dark" });
  await loginAs(dark, ADMIN);
  await dark.goto(STATS);
  await dark.getByRole("heading", { name: "Estadísticas" }).waitFor();
  await shot(dark, "estadisticas-oscuro.png");
  void vera;
} catch (e) {
  fail("excepción en el recorrido", String(e?.stack ?? e).slice(0, 900));
  console.log("\n--- ultimas lineas de la app ---");
  console.log(logs.slice(-30).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  appA?.kill();
  await fake?.close().catch(() => {});
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
}

process.exit(finish());
