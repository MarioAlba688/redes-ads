// Prueba de extremo a extremo de los anuncios hechos desde la app (Facebook e Instagram): tope diario por cuenta,
// impulsar publicaciones, anuncios nuevos, activacion con aprobacion, presupuesto, pausa, archivo, proteccion del
// dinero (conversion de moneda, reversion de lo creado a medias, tope re-comprobado al activar), administracion de
// campañas que ya existen y permisos por rol, contra un Meta SIMULADO (fake-meta.mjs + fake-meta-ads.mjs).
// Arranca la app una vez con el worker encendido (hace falta `npm run build`). VACIA la base de pruebas (*_test).

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";
import { APP_ID, APP_SECRET, LONG_TOKEN, PAGE_TOKEN, startFakeMeta } from "./fake-meta.mjs";
import { createChecker, createDb, findChrome, requireTestDb, startApp, waitFor, waitReady } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_PORT = Number(process.env.E2E_PROMO_PORT ?? 3360);
const FAKE_PORT = Number(process.env.E2E_FAKE_META_PORT ?? 4060);
const APP = `http://localhost:${APP_PORT}`;
const SETUP_TOKEN = "codigo-de-prueba-123";
const SHOTS = process.env.E2E_SHOTS_DIR;

const ADMIN = { name: "Mario Alba", email: "mario@example.com", pass: "clave-admin-2026" };
const USERS = {
  edgar: { id: "u-edgar-0001", name: "Edgar Editor", email: "edgar@example.com", pass: "clave-edgar-2026x", role: "EDITOR" },
  aura: { id: "u-aura-00001", name: "Aura Aprobadora", email: "aura@example.com", pass: "clave-aura-2026xx", role: "APPROVER" },
  vera: { id: "u-vera-00001", name: "Vera Lectora", email: "vera@example.com", pass: "clave-vera-2026xx", role: "VIEWER" },
};
const BRAND = "brand-reservi";
const FULL_SCOPES = "ads_read,ads_management,pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish";
const NO_WRITE_SCOPES = "ads_read,pages_show_list,pages_read_engagement";
const ACC_COP = "acc-ads-cop";
const ACC_USD = "acc-ads-usd";

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
/** JPEG minimo con un SOF0 que declara el tamano (la app solo lee la cabecera). */
function jpeg(width, height) {
  const parts = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)];
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, ...Array(9).fill(0), 0xff, 0xd9);
  return Buffer.from(parts);
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "redes-e2e-promo-media-"));
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9, 7, 7, 7]);
let counter = 0;

/** Una publicacion con su imagen. `targets` son destinos YA publicados (para impulsar). */
async function makePost({ text, status = "DRAFT", image = true, targets = [] }) {
  const id = `post-${String(++counter).padStart(4, "0")}`;
  text ??= `Publicación ${id} ${tag()}`;
  await db.sql(
    `INSERT INTO Post (id, brandId, text, status, publishedAt, createdById, aiGenerated, createdAt, updatedAt) VALUES (?, ?, ?, ?, ${status === "PUBLISHED" ? "UTC_TIMESTAMP(3)" : "NULL"}, ?, 0, NOW(3), NOW(3))`,
    [id, BRAND, text, status, USERS.edgar.id],
  );
  let storageKey = null;
  if (image) {
    storageKey = `${randomBytes(24).toString("hex")}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, storageKey), IMAGE_BYTES);
    await db.sql(
      "INSERT INTO PostMedia (id, postId, mimeType, size, width, height, storageKey, originalName, position, createdAt) VALUES (?, ?, 'image/jpeg', ?, 1080, 1350, ?, 'foto.jpg', 0, NOW(3))",
      [`${id}-m`, id, IMAGE_BYTES.length, storageKey],
    );
  }
  const ids = {};
  for (const t of targets) {
    const tid = `${id}-${t.account}`;
    ids[t.account] = tid;
    await db.sql(
      "INSERT INTO PostTarget (id, postId, accountId, status, attempts, externalId, externalUrl, publishedAt) VALUES (?, ?, ?, 'PUBLISHED', 1, ?, ?, UTC_TIMESTAMP(3))",
      [tid, id, t.account, t.externalId, `https://www.example-red.test/${t.externalId}`],
    );
  }
  return { id, text, storageKey, targets: ids };
}

const promo = async (id) =>
  (await db.sql(
    "SELECT id, kind, name, objective, status, effectiveStatus, dailyBudget, currency, durationDays, metaCampaignId, metaAdSetId, metaCreativeId, metaAdId, activatedById, createdById, error, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(3), endsAt) AS endsIn FROM AdPromotion WHERE id=?",
    [id],
  ))[0];
const promoCount = async () => Number((await db.sql("SELECT COUNT(*) c FROM AdPromotion"))[0].c);
const capOf = async (id) => {
  const r = (await db.sql("SELECT dailyBudgetCap FROM SocialAccount WHERE id=?", [id]))[0].dailyBudgetCap;
  return r === null ? null : Number(r);
};
const setCap = (id, cap) => db.sql("UPDATE SocialAccount SET dailyBudgetCap=? WHERE id=?", [cap, id]);
/** Espera a que algo ocurra (en la base o en Meta). Los avisos de exito desaparecen cuando el estado cambia y el boton se desmonta: no sirven para esperar. */
const until = async (fn, timeout = 25_000) => !!(await waitFor(async () => ((await fn()) ? true : null), { timeout, interval: 300 }));

let fake;
let appA;
let browser;
const logs = [];
try {
  await db.reset();
  fake = await startFakeMeta(FAKE_PORT, `${APP}/api/meta/callback`);
  const metaAds = () => fake.ads.state();
  const calm = () => fake.setScenario({ adsFail: {}, adsBudgetFactor: 1, adsReview: "ok", adsEnhancements: "ok", adsMinBudget: null, tokens: "valid" });

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
  const newPage = async (viewport = { width: 1280, height: 1000 }, extra = {}) => {
    const ctx = await browser.newContext({ viewport, ...extra });
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

  // ------------------------------------------------------------ 0. instalacion, usuarios, marca y cuentas
  const { page: admin, ctx: adminCtx } = await newPage();
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
    await db.sql("INSERT INTO User (id, email, name, passwordHash, role, active, failedLogins, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 0, NOW(3), NOW(3))", [u.id, u.email, u.name, bcrypt.hashSync(u.pass, 4), u.role]);
  }
  await db.sql("INSERT INTO Brand (id, name, description, language, timezone, createdAt, updatedAt) VALUES (?, 'Reservi', 'Negocio de prueba.', 'es', 'America/Bogota', NOW(3), NOW(3))", [BRAND]);
  const account = (id, kind, ext, name, token, { scopes = FULL_SCOPES, currency = null, metadata = null } = {}) =>
    db.sql(
      "INSERT INTO SocialAccount (id, platform, kind, externalId, name, status, accessTokenEnc, scopes, currency, timezone, metadata, brandId, createdAt, updatedAt) VALUES (?, 'META', ?, ?, ?, 'ACTIVE', ?, ?, ?, 'America/Bogota', ?, ?, NOW(3), NOW(3))",
      [id, kind, ext, name, encrypt(token), scopes, currency, metadata ? JSON.stringify(metadata) : null, BRAND],
    );
  await account(ACC_COP, "AD_ACCOUNT", "1002", "Reservi Colombia (COP)", LONG_TOKEN, { currency: "COP", metadata: { accountStatus: 1 } });
  await account(ACC_USD, "AD_ACCOUNT", "1001", "Reservi Global (USD)", LONG_TOKEN, { currency: "USD", metadata: { accountStatus: 1 } });
  await account("acc-fb", "FACEBOOK_PAGE", "P-1", "Mi Marca", PAGE_TOKEN);
  await account("acc-ig", "INSTAGRAM_PROFILE", "IG-1", "Mi Marca Oficial", PAGE_TOKEN, { metadata: { pageId: "P-1" } });

  const published = await makePost({ text: `Reservas sin llamadas ${tag()}`, status: "PUBLISHED", targets: [{ account: "acc-fb", externalId: "P-1_10" }, { account: "acc-ig", externalId: "IGM-4" }] });
  const draft = await makePost({ text: `Promo de octubre ${tag()}`, status: "DRAFT" });
  const noImage = await makePost({ text: `Sin imagen ${tag()}`, status: "DRAFT", image: false });
  const FB = published.targets["acc-fb"];
  const IG = published.targets["acc-ig"];

  const { page: edgar } = await newPage();
  const { page: aura } = await newPage();
  const { page: vera } = await newPage();
  await loginAs(edgar, USERS.edgar);
  await loginAs(aura, USERS.aura);
  await loginAs(vera, USERS.vera);

  // helpers de la pantalla de crear
  const openBoost = async (page, target, over = {}) => {
    await page.goto(`${APP}/anuncios/nuevo?tipo=impulsar&destino=${target}`);
    await page.locator("#cuenta").selectOption(over.account ?? ACC_COP);
    await page.locator("#presupuesto").fill(over.budget ?? "20.000");
    await page.locator("#dias").fill(String(over.days ?? 7));
    if (over.name) await page.locator("#nombre").fill(over.name);
  };
  const submit = (page) => page.getByRole("button", { name: /Crear anuncio/ }).click();
  const waitCreated = async (page) => {
    await page.waitForURL(/\/anuncios\/creados\/[^/?]+\?creado=1/, { timeout: 40_000 });
    return page.url().match(/creados\/([^/?]+)/)[1];
  };
  // Next.js tiene su propio role="alert" vacio (el anunciador de rutas): se espera un aviso que tenga texto.
  const formError = async (page) => {
    const alerts = page.locator('[role="alert"]').filter({ hasText: /\S/ });
    await alerts.first().waitFor({ timeout: 40_000 });
    return (await alerts.allInnerTexts()).join(" | ");
  };

  // ------------------------------------------------------------ 1. el tope diario (Cuentas)
  await admin.goto(`${APP}/cuentas`);
  const capInput = (acc) => admin.locator(`#cap-${acc}`);
  check("el administrador ve el tope de cada cuenta publicitaria, sin fijar", (await capInput(ACC_COP).count()) === 1 && (await capInput(ACC_USD).count()) === 1 && (await admin.getByText("Sin tope diario no se pueden crear ni activar anuncios").count()) === 2);

  // Sin tope no se puede crear nada (ni siquiera llega a Meta).
  await openBoost(edgar, FB);
  await submit(edgar);
  const noCapMsg = await formError(edgar);
  check("sin tope fijado no se crea nada y se dice quien lo fija", /todavía no tiene un tope/.test(noCapMsg) && (await promoCount()) === 0 && metaAds().campaigns.length === 0, noCapMsg);

  const saveCap = async (acc, text) => {
    await admin.goto(`${APP}/cuentas`);
    await capInput(acc).fill(text);
    await capInput(acc).locator("xpath=ancestor::form").getByRole("button", { name: "Guardar" }).click();
    await admin.waitForLoadState("networkidle");
  };
  await saveCap(ACC_COP, "50.000");
  check("«50.000» en pesos es cincuenta mil (no cincuenta)", (await capOf(ACC_COP)) === 50000);
  await saveCap(ACC_USD, "10,50");
  check("«10,50» en dólares es diez con cincuenta", (await capOf(ACC_USD)) === 10.5);

  await saveCap(ACC_COP, "abc");
  check("un tope que no se entiende se rechaza y no cambia el que había", (await admin.getByText(/No entendí «abc»/).count()) === 1 && (await capOf(ACC_COP)) === 50000);
  await saveCap(ACC_COP, "50,5");
  check("pesos con decimales se rechazan (la moneda no los tiene)", (await capOf(ACC_COP)) === 50000);
  await saveCap(ACC_USD, "50.000");
  check("«50.000» en dólares es ambiguo y se rechaza en vez de adivinar", (await capOf(ACC_USD)) === 10.5);

  await edgar.goto(`${APP}/cuentas`);
  check("quien no es administrador ve el tope pero no puede cambiarlo", (await edgar.locator(`#cap-${ACC_COP}`).count()) === 0 && (await edgar.getByText(/Tope diario por anuncio/).first().isVisible()));
  const audits = (await db.sql("SELECT action FROM AuditLog WHERE action LIKE 'ads.cap%'")).map((r) => r.action);
  check("fijar el tope queda en la auditoría", audits.includes("ads.cap_set"));

  // ------------------------------------------------------------ 2. impulsar una publicacion de Facebook
  await openBoost(edgar, FB, { name: "Impulso de prueba FB" });
  check("el formulario avisa el tope y calcula el gasto máximo (20.000 x 7)", (await edgar.getByText(/Tope de esta cuenta/).count()) === 1 && /140\.000/.test(await edgar.locator("main").innerText()));
  await shot(edgar, "anuncio-nuevo.png");
  await submit(edgar);
  const fbId = await waitCreated(edgar);
  const fbPromo = await promo(fbId);
  check("se crea en pausa y la ficha lo explica", fbPromo.status === "PAUSED" && (await edgar.getByText(/Anuncio creado en Meta, en pausa/).count()) === 1);

  let m = metaAds();
  const camp = m.campaigns.find((c) => c.id === fbPromo.metaCampaignId);
  const set = m.adsets.find((s) => s.id === fbPromo.metaAdSetId);
  const ad = m.ads.find((a) => a.id === fbPromo.metaAdId);
  check("en Meta hay una campaña, un conjunto y un anuncio, TODOS en pausa", camp?.status === "PAUSED" && set?.status === "PAUSED" && ad?.status === "PAUSED" && m.campaigns.length === 1);
  check("la campaña usa el objetivo de interacción y declara special_ad_categories", camp.objective === "OUTCOME_ENGAGEMENT" && m.log.find((l) => l.op === "create_campaign").params.special_ad_categories === "[]");
  check("el presupuesto de 20.000 pesos llega como 20000 (offset 1 del peso), no como 2000000", set.daily_budget === 20000);
  const adsetParams = m.log.find((l) => l.op === "create_adset").params;
  const targeting = JSON.parse(adsetParams.targeting);
  check("el conjunto declara advantage_audience en 0, país Colombia y la edad elegida", targeting.targeting_automation.advantage_audience === 0 && targeting.geo_locations.countries[0] === "CO" && targeting.age_min === 18 && targeting.age_max === 65);
  check("optimiza la interacción de la publicación y promueve la página", adsetParams.optimization_goal === "POST_ENGAGEMENT" && adsetParams.destination_type === "ON_POST" && JSON.parse(adsetParams.promoted_object).page_id === "P-1");
  check("el anuncio apunta a la publicación de Facebook por su id", m.log.find((l) => l.op === "create_creative").params.object_story_id === "P-1_10");
  check("la duración queda hasta unos días después (se fija exacta al activar)", Math.abs(set.end_time - (Date.now() / 1000 + 8 * 86400)) < 600);
  check("queda registrado quién lo creó y la auditoría", fbPromo.createdById === USERS.edgar.id && (await db.sql("SELECT COUNT(*) c FROM AuditLog WHERE action='ads.created'"))[0].c > 0n);

  // ------------------------------------------------------------ 3. aprobacion: solo quien aprueba activa
  await edgar.goto(`${APP}/anuncios/creados/${fbId}`);
  check("quien crea el anuncio NO puede activarlo (ni ve el botón)", (await edgar.getByRole("button", { name: "Activar anuncio" }).count()) === 0 && (await edgar.getByText(/Lo activa una persona con permiso de aprobar/).count()) === 1);
  await vera.goto(`${APP}/anuncios/creados/${fbId}`);
  check("solo lectura ve el anuncio pero ninguna acción", (await vera.getByRole("button").filter({ hasText: /Activar|Pausar|Archivar|Cambiar/ }).count()) === 0);

  await aura.goto(`${APP}/anuncios/creados`);
  check("la lista avisa a quien aprueba que hay un anuncio esperando", (await aura.getByText(/1 anuncio en pausa esperando/).count()) === 1);
  await aura.goto(`${APP}/anuncios/creados/${fbId}`);
  aura.once("dialog", async (d) => {
    check("al activar pide confirmar y dice cuánto puede gastar (20.000 por día, máximo 140.000)", /20\.000/.test(d.message()) && /140\.000/.test(d.message()) && /7 días/.test(d.message()), d.message());
    await d.accept();
  });
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  await until(async () => (await promo(fbId)).status === "ACTIVE");
  m = metaAds();
  const live = await promo(fbId);
  check("activar pone campaña, conjunto y anuncio en activo en Meta", m.campaigns[0].status === "ACTIVE" && m.adsets[0].status === "ACTIVE" && m.ads[0].status === "ACTIVE" && live.status === "ACTIVE" && live.activatedById === USERS.aura.id);
  check("al activar se fija el fin exacto: 7 días desde ahora", live.endsIn >= 7 * 1440 - 3 && live.endsIn <= 7 * 1440 && Math.abs(m.adsets[0].end_time - (Date.now() / 1000 + 7 * 86400)) < 300, String(live.endsIn));
  check("queda en la auditoría quién lo activó", (await db.sql("SELECT userId FROM AuditLog WHERE action='ads.activated'")).some((r) => r.userId === USERS.aura.id));

  // ------------------------------------------------------------ 4. presupuesto (sin pasar del tope), pausa y archivo
  await aura.goto(`${APP}/anuncios/creados/${fbId}`);
  const budgetBox = aura.locator("#nuevo-presupuesto");
  await budgetBox.fill("30.000");
  await aura.getByRole("button", { name: "Cambiar", exact: true }).click();
  await aura.getByText("Presupuesto actualizado").waitFor();
  check("cambiar el presupuesto lo guarda en Meta y en la app", metaAds().adsets[0].daily_budget === 30000 && Number((await promo(fbId)).dailyBudget) === 30000);

  await aura.goto(`${APP}/anuncios/creados/${fbId}`);
  await aura.locator("#nuevo-presupuesto").fill("60.000");
  await aura.getByRole("button", { name: "Cambiar", exact: true }).click();
  await aura.getByText(/supera el tope de esta cuenta/).waitFor();
  check("un presupuesto por encima del tope se rechaza y Meta queda como estaba", metaAds().adsets[0].daily_budget === 30000);
  await edgar.goto(`${APP}/anuncios/creados/${fbId}`);
  check("quien solo crea no puede cambiar el presupuesto (mueve dinero)", (await edgar.locator("#nuevo-presupuesto").count()) === 0);

  await edgar.getByRole("button", { name: "Pausar", exact: true }).click();
  await until(async () => (await promo(fbId)).status === "PAUSED");
  m = metaAds();
  check("quien crea sí puede pausar (pausar nunca gasta): todo en pausa", m.campaigns[0].status === "PAUSED" && m.adsets[0].status === "PAUSED" && m.ads[0].status === "PAUSED" && (await promo(fbId)).status === "PAUSED");

  await aura.goto(`${APP}/anuncios/creados/${fbId}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Archivar" }).click();
  await until(async () => (await promo(fbId)).status === "ARCHIVED");
  check("archivar deja la campaña archivada en Meta y el anuncio archivado aquí", metaAds().campaigns[0].status === "ARCHIVED" && (await promo(fbId)).status === "ARCHIVED");

  // ------------------------------------------------------------ 5. Instagram (dólares, offset 100)
  await openBoost(edgar, IG, { account: ACC_USD, budget: "10,51", name: "Impulso IG" });
  await submit(edgar);
  check("un presupuesto por encima del tope (10,51 > 10,50) no se envía: el formulario lo explica", (await edgar.getByText(/supera el tope de esta cuenta/).count()) >= 1 && (await promoCount()) === 1);
  await edgar.locator("#presupuesto").fill("10,50");
  await submit(edgar);
  const igId = await waitCreated(edgar);
  m = metaAds();
  const igPromo = await promo(igId);
  const igSet = m.adsets.find((s) => s.id === igPromo.metaAdSetId);
  const igCreative = m.log.filter((l) => l.op === "create_creative").at(-1).params;
  check("10,50 dólares llegan como 1050 (offset 100)", igSet.daily_budget === 1050);
  check("impulsar Instagram manda la página, la cuenta de Instagram y la publicación", igCreative.object_id === "P-1" && igCreative.instagram_user_id === "IG-1" && igCreative.source_instagram_media_id === "IGM-4");
  check("se limita a la plataforma Instagram", JSON.parse(m.log.filter((l) => l.op === "create_adset").at(-1).params.targeting).publisher_platforms[0] === "instagram");

  // ------------------------------------------------------------ 6. anuncio nuevo (con imagen y enlace)
  await edgar.goto(`${APP}/anuncios/nuevo?tipo=anuncio&publicacion=${draft.id}`);
  check("el anuncio nuevo parte del texto de la publicación", (await edgar.locator("#texto").inputValue()) === draft.text);
  await edgar.locator("#cuenta").selectOption(ACC_COP);
  await edgar.locator("#presupuesto").fill("25000");
  await edgar.locator("#titular").fill("Reserva hoy");
  await edgar.locator("#enlace").fill("https://reservi.co/reservas");
  await edgar.locator("#boton").selectOption("BOOK_NOW");
  fake.setScenario({ adsEnhancements: "required" });
  await submit(edgar);
  const adId = await waitCreated(edgar);
  m = metaAds();
  const spec = JSON.parse(m.log.filter((l) => l.op === "create_creative").at(-1).params.object_story_spec);
  const expectedHash = sha(IMAGE_BYTES).slice(0, 32);
  check("sube la imagen a Meta y la usa en el anuncio (por su código)", m.images.length === 1 && m.images[0].hash === expectedHash && spec.link_data.image_hash === expectedHash);
  check("el anuncio lleva texto, titular, enlace y botón", spec.link_data.message === draft.text && spec.link_data.name === "Reserva hoy" && spec.link_data.link === "https://reservi.co/reservas" && spec.link_data.call_to_action.type === "BOOK_NOW");
  check("el anuncio sale a nombre de la página, con la cuenta de Instagram vinculada", spec.page_id === "P-1" && spec.instagram_user_id === "IG-1");
  check("las visitas al sitio optimizan los clics en el enlace", m.log.filter((l) => l.op === "create_adset").at(-1).params.optimization_goal === "LINK_CLICKS");
  check("si Meta pide decidir sobre las «mejoras estándar», se reintenta sin ellas y se crea igual", m.log.filter((l) => l.op === "create_creative").at(-1).params.degrees_of_freedom_spec?.includes("OPT_OUT") && (await promo(adId)).status === "PAUSED");
  calm();

  await edgar.goto(`${APP}/anuncios/nuevo?tipo=anuncio&publicacion=${noImage.id}`);
  await edgar.locator("#cuenta").selectOption(ACC_COP);
  check("una publicación sin imagen avisa que el anuncio la necesita", (await edgar.getByText(/no tiene imagen: el anuncio la necesita/).count()) === 1);

  // El archivo de la imagen ya no esta en el servidor (redespliegue sin volumen, o la publicacion se creo en otra copia de la app)
  // (a) el formulario ya sabe que la imagen se perdio: lo dice y manda a restaurarla
  const lost2 = await makePost({ text: `Imagen ya perdida ${tag()}`, status: "DRAFT" });
  fs.rmSync(path.join(MEDIA_DIR, lost2.storageKey));
  await edgar.goto(`${APP}/anuncios/nuevo?tipo=anuncio&publicacion=${lost2.id}`);
  await edgar.locator("#cuenta").selectOption(ACC_COP);
  check("si la imagen de la publicación ya se perdió, el formulario lo dice y lleva a volver a subirla", (await edgar.getByText(/La imagen de esa publicación ya no está en el servidor/).count()) >= 1 && (await edgar.getByRole("link", { name: "Abre la publicación para volver a subirla" }).getAttribute("href")) === `/publicaciones/${lost2.id}` && (await edgar.locator("#fuente option", { hasText: "imagen perdida" }).count()) >= 1);

  // (b) el archivo desaparece justo despues de abrir el formulario: el servidor lo detecta y no deja nada a medias
  const lost = await makePost({ text: `Imagen perdida ${tag()}`, status: "DRAFT" });
  await edgar.goto(`${APP}/anuncios/nuevo?tipo=anuncio&publicacion=${lost.id}`);
  await edgar.locator("#cuenta").selectOption(ACC_COP);
  await edgar.locator("#presupuesto").fill("20000");
  await edgar.locator("#enlace").fill("https://reservi.co");
  fs.rmSync(path.join(MEDIA_DIR, lost.storageKey));
  await submit(edgar);
  const lostMsg = await formError(edgar);
  check("si el archivo de la imagen ya no está, lo explica (volumen de MEDIA_DIR, otra copia de la app) y dice qué hacer", /No se encontró el archivo de la imagen en este servidor/.test(lostMsg) && /MEDIA_DIR/.test(lostMsg) && /Vuelve a subir la imagen/.test(lostMsg), lostMsg);
  const lostCamps = metaAds().campaigns.filter((c) => c.name.startsWith("Anuncio: Imagen perdida"));
  check("y no queda nada creado en Meta (se borra lo que se alcanzó a crear)", lostCamps.length === 1 && lostCamps.every((c) => c.status === "DELETED") && metaAds().ads.filter((a) => a.name.startsWith("Anuncio: Imagen perdida")).length === 0);
  check("el registro queda como «No se pudo crear»", (await db.sql("SELECT status FROM AdPromotion WHERE name LIKE 'Anuncio: Imagen perdida%'"))[0]?.status === "FAILED");

  // ------------------------------------------------------------ 6b. restaurar la imagen perdida de una publicacion YA publicada
  const gone = await makePost({ text: `Publicada sin archivo ${tag()}`, status: "PUBLISHED", targets: [{ account: "acc-fb", externalId: "P-1_77" }] });
  fs.rmSync(path.join(MEDIA_DIR, gone.storageKey));
  const mediaUrl = `${APP}/api/posts/${gone.id}/media/${gone.id}-m`;
  const jpgFile = (name, w, h) => ({ name, mimeType: "image/jpeg", buffer: jpeg(w, h) });

  await edgar.goto(`${APP}/publicaciones/${gone.id}`);
  check("la ficha de una publicación publicada avisa que el archivo de la imagen se perdió y ofrece volver a subirlo", (await edgar.getByText("El archivo de esta imagen ya no está en el servidor.").count()) === 1 && (await edgar.locator(`#restaurar-${gone.id}-m`).count()) === 1);
  await shot(edgar, "publicacion-imagen-perdida.png");
  await vera.goto(`${APP}/publicaciones/${gone.id}`);
  check("solo lectura ve el aviso pero no puede subir nada", (await vera.getByText("El archivo de esta imagen ya no está en el servidor.").count()) === 1 && (await vera.locator(`#restaurar-${gone.id}-m`).count()) === 0);

  await edgar.locator(`#restaurar-${gone.id}-m`).setInputFiles(jpgFile("otra.jpg", 500, 500));
  await edgar.getByText(/La imagen debe ser la original: medir 1080 × 1350 px y esta mide 500 × 500/).waitFor();
  check("una imagen de otro tamaño se rechaza (debe ser la original) y no cambia nada", (await db.sql("SELECT storageKey FROM PostMedia WHERE id=?", [`${gone.id}-m`]))[0].storageKey === gone.storageKey && !fs.existsSync(path.join(MEDIA_DIR, gone.storageKey)));
  await edgar.locator(`#restaurar-${gone.id}-m`).setInputFiles({ name: "texto.jpg", mimeType: "image/jpeg", buffer: Buffer.from("no soy una imagen") });
  await edgar.getByText(/no es una imagen/i).first().waitFor();
  check("un archivo que no es una imagen se rechaza por su contenido", true);

  const original = jpeg(1080, 1350);
  await edgar.locator(`#restaurar-${gone.id}-m`).setInputFiles({ name: "original.jpg", mimeType: "image/jpeg", buffer: original });
  check("con la imagen original el aviso desaparece y la imagen vuelve a verse", await until(async () => (await edgar.locator(`#restaurar-${gone.id}-m`).count()) === 0 && (await edgar.getByAltText("Imagen de la publicación").count()) === 1));
  const restoredRow = (await db.sql("SELECT storageKey, size FROM PostMedia WHERE id=?", [`${gone.id}-m`]))[0];
  check("el archivo quedó en la carpeta de imágenes (con un nombre nuevo) y registrado en la base", restoredRow.storageKey !== gone.storageKey && fs.existsSync(path.join(MEDIA_DIR, restoredRow.storageKey)) && sha(fs.readFileSync(path.join(MEDIA_DIR, restoredRow.storageKey))) === sha(original) && Number(restoredRow.size) === original.length);
  check("queda en la auditoría", (await db.sql("SELECT COUNT(*) c FROM AuditLog WHERE action='post.media_restored'"))[0].c > 0n);

  const again = await edgar.context().request.post(mediaUrl, { multipart: { file: jpgFile("x.jpg", 1080, 1350) }, headers: { origin: APP } });
  check("si el archivo ya está en el servidor no se puede reemplazar", again.status() === 409 && /no hace falta restaurarlo/.test((await again.json()).error));

  const approved = await makePost({ text: `Aprobada con archivo perdido ${tag()}`, status: "APPROVED", targets: [{ account: "acc-fb", externalId: "P-1_78" }] });
  await db.sql("UPDATE PostTarget SET status='PENDING', externalId=NULL WHERE postId=?", [approved.id]);
  fs.rmSync(path.join(MEDIA_DIR, approved.storageKey));
  const notAllowed = await edgar.context().request.post(`${APP}/api/posts/${approved.id}/media/${approved.id}-m`, { multipart: { file: jpgFile("x.jpg", 1080, 1350) }, headers: { origin: APP } });
  check("lo aprobado o programado NO se puede cambiar por esta vía (solo lo ya publicado)", notAllowed.status() === 409 && /ya se publicó/.test((await notAllowed.json()).error) && (await db.sql("SELECT storageKey FROM PostMedia WHERE id=?", [`${approved.id}-m`]))[0].storageKey === approved.storageKey);

  const gone2 = await makePost({ text: `Publicada sin archivo 2 ${tag()}`, status: "PUBLISHED", targets: [{ account: "acc-fb", externalId: "P-1_79" }] });
  fs.rmSync(path.join(MEDIA_DIR, gone2.storageKey));
  const viewerTry = await vera.context().request.post(`${APP}/api/posts/${gone2.id}/media/${gone2.id}-m`, { multipart: { file: jpgFile("x.jpg", 1080, 1350) }, headers: { origin: APP } });
  check("solo lectura no puede restaurar una imagen (aunque arme la petición a mano)", viewerTry.status() === 401 && !fs.existsSync(path.join(MEDIA_DIR, gone2.storageKey)));
  const evil = await edgar.context().request.post(`${APP}/api/posts/${gone2.id}/media/${gone2.id}-m`, { multipart: { file: jpgFile("x.jpg", 1080, 1350) }, headers: { origin: "https://sitio-malicioso.example" } });
  check("una petición de otro sitio se rechaza", evil.status() === 403);
  const wrongPost = await edgar.context().request.post(`${APP}/api/posts/${gone.id}/media/${gone2.id}-m`, { multipart: { file: jpgFile("x.jpg", 1080, 1350) }, headers: { origin: APP } });
  check("una imagen no se puede restaurar a través de otra publicación", wrongPost.status() === 404);

  // Con la imagen restaurada, esa publicación ya sirve para un anuncio nuevo
  await edgar.goto(`${APP}/anuncios/nuevo?tipo=anuncio&publicacion=${gone.id}`);
  check("y el formulario de anuncio nuevo deja de avisar de la imagen perdida de esa publicación", (await edgar.getByText(/ya no está en el servidor/).count()) === 0 && !(await edgar.locator(`#fuente option[value="${gone.id}"]`).innerText()).includes("imagen perdida"));

  // ------------------------------------------------------------ 7. proteccion del dinero: nada queda a medias ni mal convertido
  const before = metaAds();
  const liveObjects = () => {
    const s = metaAds();
    return [...s.campaigns, ...s.adsets, ...s.ads].filter((o) => o.status !== "DELETED" && o.status !== "ARCHIVED" && o.status !== "PAUSED");
  };

  // 7a. Meta guarda un presupuesto distinto del pedido (conversión de moneda mal hecha): se borra todo.
  fake.setScenario({ adsBudgetFactor: 100 });
  await openBoost(edgar, FB, { name: "Presupuesto mal convertido" });
  await submit(edgar);
  const factorMsg = await formError(edgar);
  const failedRow = (await db.sql("SELECT id, status, error FROM AdPromotion WHERE name='Presupuesto mal convertido'"))[0];
  const newCampaigns = metaAds().campaigns.filter((c) => c.name === "Presupuesto mal convertido");
  check("si Meta registra un presupuesto distinto del pedido, se cancela y se explica", /registró un presupuesto diario/.test(factorMsg) && /se canceló la creación/.test(factorMsg), factorMsg);
  check("y lo que se había creado en Meta se borra (nada queda activo ni pausado)", newCampaigns.length === 1 && newCampaigns.every((c) => c.status === "DELETED") && metaAds().adsets.filter((s) => s.name === "Presupuesto mal convertido").every((s) => s.status === "DELETED") && metaAds().ads.filter((a) => a.name === "Presupuesto mal convertido").every((a) => a.status === "DELETED"));
  check("el registro queda como «No se pudo crear» con el motivo", failedRow.status === "FAILED" && /presupuesto diario/.test(failedRow.error));
  calm();

  // 7b. Falla el último paso: se borra lo anterior.
  fake.setScenario({ adsFail: { ad: "server" } });
  await openBoost(edgar, FB, { name: "Falla al final" });
  await submit(edgar);
  const serverMsg = await formError(edgar);
  const partial = metaAds();
  check("si falla el último paso, se borran la campaña y el conjunto ya creados", /problema temporal/.test(serverMsg) && partial.campaigns.filter((c) => c.name === "Falla al final").every((c) => c.status === "DELETED") && partial.adsets.filter((s) => s.name === "Falla al final").every((s) => s.status === "DELETED"), serverMsg);
  check("no queda nada activo en Meta tras los fallos", liveObjects().length === 0);
  calm();

  // 7c. Errores de Meta traducidos
  fake.setScenario({ adsFail: { adset: "payment" } });
  await openBoost(edgar, FB, { name: "Sin pago" });
  await submit(edgar);
  const payMsg = await formError(edgar);
  check("sin método de pago: lo dice en español y borra la campaña", /método de pago/.test(payMsg) && metaAds().campaigns.filter((c) => c.name === "Sin pago").every((c) => c.status === "DELETED"), payMsg);

  fake.setScenario({ adsFail: { campaign: "perm" } });
  await openBoost(edgar, FB, { name: "Sin permiso" });
  await submit(edgar);
  const permMsg = await formError(edgar);
  check("sin permiso de Meta: nombra ads_management y trae el detalle de Meta", /ads_management/.test(permMsg) && /Detalle de Meta/.test(permMsg), permMsg);

  fake.setScenario({ adsFail: { creative: "devmode" } });
  await openBoost(edgar, FB, { name: "App en desarrollo" });
  await submit(edgar);
  const devMsg = await formError(edgar);
  check("app de Meta en modo desarrollo: lo explica en español y dice dónde cambiarlo", /modo de desarrollo/.test(devMsg) && /«Publicar»/.test(devMsg) && /Detalle de Meta/.test(devMsg), devMsg);
  check("y no deja nada creado en Meta (campaña y conjunto borrados)", metaAds().campaigns.filter((c) => c.name === "App en desarrollo").every((c) => c.status === "DELETED") && metaAds().adsets.filter((s) => s.name === "App en desarrollo").every((s) => s.status === "DELETED"));
  const devRow = (await db.sql("SELECT id, status FROM AdPromotion WHERE name='App en desarrollo'"))[0];
  await edgar.goto(`${APP}/anuncios/creados/${devRow.id}`);
  check("la ficha del fallido manda a publicar la app de Meta y a crear de nuevo", devRow.status === "FAILED" && (await edgar.getByText(/modo Publicado/).count()) >= 1 && (await edgar.getByRole("link", { name: "Crear de nuevo con estos datos" }).count()) === 1);
  calm();

  fake.setScenario({ adsMinBudget: 30000, adsFail: {} });
  await openBoost(edgar, FB, { name: "Presupuesto bajo", budget: "20000" });
  await submit(edgar);
  check("presupuesto por debajo del mínimo de Meta: lo explica", /mínimo/.test(await formError(edgar)));
  calm();

  fake.setScenario({ adsFail: { campaign: "auth" } });
  await openBoost(edgar, FB, { name: "Token vencido" });
  await submit(edgar);
  const authMsg = await formError(edgar);
  const expiredRow = (await db.sql("SELECT status FROM SocialAccount WHERE id=?", [ACC_COP]))[0];
  check("con la conexión vencida lo dice y deja la cuenta como «Vencida»", /venció/.test(authMsg) && expiredRow.status === "EXPIRED", authMsg);
  await db.sql("UPDATE SocialAccount SET status='ACTIVE' WHERE id=?", [ACC_COP]);
  calm();
  check("los intentos fallidos no dejaron anuncios en pausa ni activos (solo los 2 creados bien: Instagram y el anuncio nuevo)", (await db.sql("SELECT COUNT(*) c FROM AdPromotion WHERE status IN ('PAUSED','ACTIVE')"))[0].c === 2n);

  // 7c2. Crear de nuevo un anuncio que no se pudo crear (los de arriba quedaron como «No se pudo crear»)
  const lowRow = (await db.sql("SELECT id, status, error FROM AdPromotion WHERE name='Presupuesto bajo'"))[0];
  check("el anuncio «Presupuesto bajo» quedó como «No se pudo crear»", lowRow?.status === "FAILED", String(lowRow?.status));
  await edgar.goto(`${APP}/anuncios/creados`);
  const lowListRow = edgar.locator("tr", { hasText: "Presupuesto bajo" });
  check("en la lista, el editor ve «Crear de nuevo» en la fila del anuncio fallido", (await lowListRow.getByRole("link", { name: "Crear de nuevo" }).count()) === 1);
  check("y no en los que se crearon bien", (await edgar.locator("tr", { hasText: "Impulso de prueba FB" }).getByRole("link", { name: "Crear de nuevo" }).count()) === 0);
  await vera.goto(`${APP}/anuncios/creados`);
  check("quien solo mira la lista no ve «Crear de nuevo»", (await vera.getByRole("link", { name: "Crear de nuevo" }).count()) === 0);

  await edgar.goto(`${APP}/anuncios/creados/${lowRow.id}`);
  check("la ficha del fallido explica qué corregir (subir el presupuesto sin pasar del tope)", (await edgar.getByText(/Sube el presupuesto diario por encima del mínimo/).count()) === 1);
  check("y ofrece «Crear de nuevo con estos datos»; el editor no puede descartar", (await edgar.getByRole("link", { name: "Crear de nuevo con estos datos" }).count()) === 1 && (await edgar.getByRole("button", { name: "Descartar" }).count()) === 0);
  await aura.goto(`${APP}/anuncios/creados/${lowRow.id}`);
  check("quien aprueba puede descartar pero no crear de nuevo", (await aura.getByRole("button", { name: "Descartar" }).count()) === 1 && (await aura.getByRole("link", { name: "Crear de nuevo con estos datos" }).count()) === 0);
  await vera.goto(`${APP}/anuncios/creados/${lowRow.id}`);
  check("quien solo mira no tiene ninguna acción sobre el fallido", (await vera.getByRole("button", { name: "Descartar" }).count()) === 0 && (await vera.getByRole("link", { name: "Crear de nuevo con estos datos" }).count()) === 0);

  await Promise.all([edgar.waitForURL((u) => u.pathname === "/anuncios/nuevo" && u.search.includes("copiar=")), edgar.getByRole("link", { name: "Crear de nuevo con estos datos" }).click()]);
  await edgar.locator("#presupuesto").waitFor();
  check("el formulario abre con los datos de antes y el aviso de qué falló", (await edgar.getByText(/Estás creando de nuevo un anuncio que no se pudo crear/).count()) === 1 && /mínimo|más de/.test(await edgar.locator("main").innerText()));
  check("con el nombre, el presupuesto y los días del intento anterior", (await edgar.locator("#nombre").inputValue()) === "Presupuesto bajo" && (await edgar.locator("#presupuesto").inputValue()) === "20000" && (await edgar.locator("#dias").inputValue()) === "7");
  check("sin las pestañas de tipo (no se cambia de tipo al corregir)", (await edgar.getByRole("group", { name: "Tipo de anuncio" }).count()) === 0);
  await vera.goto(`${APP}/anuncios/nuevo?copiar=${lowRow.id}`);
  check("quien no puede crear anuncios no abre el formulario", (await vera.locator("#presupuesto").count()) === 0);

  // Meta sigue exigiendo más de 30.000: con lo mismo falla igual; corregido (dentro del tope de 50.000) se crea y el viejo no se toca.
  fake.setScenario({ adsMinBudget: 30000, adsFail: {} });
  await shot(edgar, "anuncios-crear-de-nuevo.png");
  await edgar.locator("#presupuesto").fill("35000");
  await submit(edgar);
  const retryId = await waitCreated(edgar);
  const retried = await promo(retryId);
  check("corregido el presupuesto, se crea de verdad (en pausa) con el nuevo valor", retried.id !== lowRow.id && retried.status === "PAUSED" && Number(retried.dailyBudget) === 35000 && retried.name === "Presupuesto bajo");
  check("y el intento anterior sigue como «No se pudo crear» (queda el historial)", (await promo(lowRow.id)).status === "FAILED");
  calm();

  // La imagen perdida: la ficha manda a restaurarla antes de crear de nuevo.
  const lostRow = (await db.sql("SELECT id FROM AdPromotion WHERE name LIKE 'Anuncio: Imagen perdida%'"))[0];
  await edgar.goto(`${APP}/anuncios/creados/${lostRow.id}`);
  check("si falló por la imagen perdida, la ficha dice que primero hay que restaurarla", (await edgar.getByText(/Primero restaura la imagen/).count()) === 1);

  // «Descartar» deja el fallido como archivado sin tocar Meta.
  const metaBeforeDiscard = JSON.stringify(metaAds());
  await aura.goto(`${APP}/anuncios/creados/${lowRow.id}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Descartar" }).click();
  check("quien aprueba puede descartar un fallido: queda archivado", await until(async () => (await promo(lowRow.id)).status === "ARCHIVED"));
  check("y descartar no toca nada en Meta", JSON.stringify(metaAds()) === metaBeforeDiscard);

  // 7d. El tope se vuelve a comprobar al activar, con lo que Meta tenga en ese momento
  await openBoost(edgar, FB, { name: "Para probar el tope", budget: "20000" });
  await submit(edgar);
  const capId = await waitCreated(edgar);
  const capPromo = await promo(capId);
  await setCap(ACC_COP, 10000);
  await aura.goto(`${APP}/anuncios/creados/${capId}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  await aura.getByText(/por encima del tope de la cuenta/).waitFor();
  check("si el administrador bajó el tope, activar se rechaza y no se toca nada en Meta", metaAds().campaigns.find((c) => c.id === capPromo.metaCampaignId).status === "PAUSED" && (await promo(capId)).status === "PAUSED");
  await setCap(ACC_COP, 50000);

  // Alguien sube el presupuesto en Meta por encima del tope: se detecta al activar.
  metaAds().adsets.find((s) => s.id === capPromo.metaAdSetId).daily_budget = 999999;
  await aura.goto(`${APP}/anuncios/creados/${capId}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  await aura.getByText(/En Meta el presupuesto diario es 999999/).waitFor();
  check("si el presupuesto en Meta ya no coincide y pasa el tope, activar se rechaza", (await promo(capId)).status === "PAUSED" && liveObjects().length === 0);
  metaAds().adsets.find((s) => s.id === capPromo.metaAdSetId).daily_budget = 20000;

  fake.setScenario({ adsFail: { activate: "server" } });
  await aura.goto(`${APP}/anuncios/creados/${capId}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  await aura.getByText(/problema temporal/).waitFor();
  check("si Meta falla al activar, el anuncio sigue en pausa (nunca activo a medias)", (await promo(capId)).status === "PAUSED" && liveObjects().length === 0);
  calm();

  // Anuncio rechazado por la revisión de Meta
  fake.setScenario({ adsReview: "disapproved" });
  await aura.goto(`${APP}/anuncios/creados/${capId}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  await until(async () => (await promo(capId)).status === "ACTIVE");
  await aura.getByRole("button", { name: "Actualizar estado" }).click();
  await aura.getByText("Estado actualizado").waitFor();
  await aura.goto(`${APP}/anuncios/creados/${capId}`);
  check("el estado real de Meta se muestra tal cual (rechazado por la revisión)", (await aura.getByText("Meta: Rechazado por Meta").count()) === 1 && (await promo(capId)).effectiveStatus === "DISAPPROVED");
  calm();

  // El proceso en segundo plano refleja lo que se cambia directamente en Meta
  const sync = await promo(capId);
  metaAds().campaigns.find((c) => c.id === sync.metaCampaignId).status = "PAUSED";
  await db.sql("UPDATE AdPromotion SET lastSyncedAt = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR) WHERE id=?", [capId]);
  const synced = await waitFor(async () => ((await promo(capId)).status === "PAUSED" ? true : null), { timeout: 25_000, interval: 400 });
  check("si alguien pausa el anuncio en Meta, el proceso en segundo plano lo refleja aquí", !!synced);

  // ------------------------------------------------------------ 8. segmentación con búsqueda en Meta
  await openBoost(edgar, FB, { name: "Con segmentación" });
  await edgar.getByLabel("Buscar un interés").fill("bell");
  await edgar.getByRole("button", { name: "Belleza" }).click();
  await edgar.getByLabel("Buscar una ciudad").fill("bogo");
  await edgar.getByRole("button", { name: /Bogotá/ }).click();
  check("los intereses y ciudades elegidos aparecen como etiquetas", (await edgar.getByText("Belleza").count()) >= 1 && (await edgar.getByRole("button", { name: "Quitar Belleza" }).count()) === 1 && (await edgar.getByLabel("Radio de Bogotá en kilómetros").inputValue()) === "25");
  await edgar.locator("select").filter({ hasText: "Todas las personas" }).selectOption("women");
  await edgar.getByLabel("Edad mínima").fill("25");
  await shot(edgar, "anuncio-segmentacion.png");
  await submit(edgar);
  const segId = await waitCreated(edgar);
  const segTargeting = JSON.parse(metaAds().log.filter((l) => l.op === "create_adset").at(-1).params.targeting);
  check("la segmentación llega a Meta: ciudad por su clave y radio en km, interés en flexible_spec, género y edad", segTargeting.geo_locations.cities[0].key === "2420605" && segTargeting.geo_locations.cities[0].radius === 25 && segTargeting.geo_locations.cities[0].distance_unit === "kilometer" && segTargeting.flexible_spec[0].interests[0].id === "6003139266461" && JSON.stringify(segTargeting.genders) === "[2]" && segTargeting.age_min === 25, JSON.stringify(segTargeting));
  void segId;

  await openBoost(edgar, FB, { name: "Ciudad europea" });
  await edgar.getByLabel("Buscar una ciudad").fill("madr");
  await edgar.getByRole("button", { name: /Madrid/ }).click();
  await submit(edgar);
  check("una ciudad de la Unión Europea se rechaza (Meta pide datos DSA que la app no recoge)", (await edgar.getByText(/Unión Europea.*DSA/).count()) >= 1);

  const apiAnon = await fetch(`${APP}/api/ads/search?type=interest&q=bell&account=${ACC_COP}`, { redirect: "manual" });
  check("la búsqueda sin sesión no responde datos", apiAnon.status === 401 || apiAnon.status === 307 || apiAnon.status === 302);
  const apiViewer = await vera.context().request.get(`${APP}/api/ads/search?type=interest&q=bell&account=${ACC_COP}`);
  check("y solo quien puede crear anuncios puede buscar", apiViewer.status() === 403);
  const apiEdgar = await edgar.context().request.get(`${APP}/api/ads/search?type=interest&q=viaj&account=${ACC_COP}`);
  check("quien crea recibe los intereses de Meta", apiEdgar.status() === 200 && (await apiEdgar.json()).results.some((r) => r.name === "Viajes"));

  // ------------------------------------------------------------ 9. campañas que ya existen en Meta
  const external = fake.ads.seed({
    account: "1002",
    name: "Campaña externa",
    objective: "OUTCOME_TRAFFIC",
    status: "PAUSED",
    adsets: [
      { name: "Conjunto A", status: "PAUSED", daily_budget: 20000, ads: [{ name: "Anuncio A1", status: "PAUSED" }] },
      { name: "Conjunto B", status: "PAUSED", daily_budget: 20000, ads: [{ name: "Anuncio B1", status: "PAUSED" }] },
    ],
  });
  const lifetime = fake.ads.seed({ account: "1002", name: "Campaña con presupuesto total", status: "PAUSED", lifetime_budget: 900000, adsets: [{ name: "Conjunto T", status: "PAUSED", lifetime_budget: 900000, ads: [] }] });

  await aura.goto(`${APP}/anuncios/campanas?cuenta=${ACC_COP}`);
  const table = aura.locator("table");
  check("lee de Meta la cuenta: campañas, conjuntos y anuncios, con su presupuesto", (await table.getByText("Campaña externa").count()) === 1 && (await table.getByText("Conjunto A").count()) === 1 && (await table.getByText("Anuncio B1").count()) === 1 && /20\.000/.test(await table.innerText()));
  check("las campañas creadas en la app se marcan y se administran en su ficha", (await aura.getByText("Creado en la app — administrarlo en su ficha").count()) >= 1);
  await shot(aura, "campanas-en-meta.png");

  const campRow = table.locator("tr", { hasText: "Campaña externa" }).first();
  aura.once("dialog", (d) => d.accept());
  await campRow.getByRole("button", { name: "Activar" }).click();
  await until(() => metaAds().campaigns.find((c) => c.id === external.campaign).status === "ACTIVE");
  check("activar una campaña cuyos conjuntos suman 40.000 (bajo el tope de 50.000) la activa en Meta", metaAds().campaigns.find((c) => c.id === external.campaign).status === "ACTIVE");

  metaAds().campaigns.find((c) => c.id === external.campaign).status = "PAUSED";
  await setCap(ACC_COP, 30000);
  await aura.goto(`${APP}/anuncios/campanas?cuenta=${ACC_COP}`);
  const campRow2 = aura.locator("table tr", { hasText: "Campaña externa" }).first();
  aura.once("dialog", (d) => d.accept());
  await campRow2.getByRole("button", { name: "Activar" }).click();
  await campRow2.getByText(/supera el tope/).waitFor();
  check("con el tope en 30.000, esa misma campaña (suma 40.000) NO se activa", metaAds().campaigns.find((c) => c.id === external.campaign).status === "PAUSED");
  await setCap(ACC_COP, 50000);

  await aura.goto(`${APP}/anuncios/campanas?cuenta=${ACC_COP}`);
  const lifeRow = aura.locator("table tr", { hasText: "Campaña con presupuesto total" }).first();
  aura.once("dialog", (d) => d.accept());
  await lifeRow.getByRole("button", { name: "Activar" }).click();
  await lifeRow.getByText(/presupuesto total/).waitFor();
  check("una campaña con presupuesto total (no diario) no se activa desde la app", metaAds().campaigns.find((c) => c.id === lifetime.campaign).status === "PAUSED");

  await aura.goto(`${APP}/anuncios/campanas?cuenta=${ACC_COP}`);
  const setRow = aura.locator("table tr", { hasText: "Conjunto A" }).first();
  await setRow.getByLabel(/Presupuesto diario en COP/).fill("25.000");
  await setRow.getByRole("button", { name: "Cambiar" }).click();
  await setRow.getByText("Presupuesto actualizado.").waitFor();
  check("cambiar el presupuesto de un conjunto existente lo guarda en Meta (25.000)", metaAds().adsets.find((s) => s.id === external.adsets[0]).daily_budget === 25000);
  await setRow.getByLabel(/Presupuesto diario en COP/).fill("90.000");
  await setRow.getByRole("button", { name: "Cambiar" }).click();
  await setRow.getByText(/supera el tope/).waitFor();
  check("y por encima del tope se rechaza", metaAds().adsets.find((s) => s.id === external.adsets[0]).daily_budget === 25000);

  await edgar.goto(`${APP}/anuncios/campanas?cuenta=${ACC_COP}`);
  const edgarRow = edgar.locator("table tr", { hasText: "Campaña externa" }).first();
  check("quien solo crea no puede activar ni cambiar presupuestos de lo existente", (await edgarRow.getByRole("button", { name: "Activar" }).count()) === 0 && (await edgar.getByLabel(/Presupuesto diario en COP/).count()) === 0);
  await vera.goto(`${APP}/anuncios/campanas?cuenta=${ACC_COP}`);
  check("solo lectura ve las campañas pero ningún botón", (await vera.locator("table").getByText("Campaña externa").count()) === 1 && (await vera.locator("table button").count()) === 0);

  // ------------------------------------------------------------ 9b. tope MENSUAL (gastado + comprometido + este anuncio) y freno automatico
  // El worker descarga el rendimiento de la cuenta (cifras deterministas del Meta simulado): ese es el "gastado en el mes".
  const bogotaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const monthStart = `${bogotaToday.slice(0, 8)}01`;
  const spentRow = async () => Number((await db.sql("SELECT COALESCE(SUM(spend),0) AS s FROM AdInsightDaily WHERE accountId=? AND date >= ? AND date <= ?", [ACC_COP, monthStart, bogotaToday]))[0].s);
  check("el worker descargó el rendimiento de la cuenta (el gasto del mes)", await until(async () => (await spentRow()) > 0));
  const S = await spentRow();
  check("hay gasto de sobra este mes para probar los topes", S > 150_000, String(S));
  check("antes de esta sección no hay ningún anuncio activo", Number((await db.sql("SELECT COUNT(*) c FROM AdPromotion WHERE status='ACTIVE'"))[0].c) === 0);

  const monthlyInput = (acc) => admin.locator(`#capm-${acc}`);
  const submitCaps = async (acc) => {
    // Solo se pulsa: el aviso anterior sigue en pantalla hasta que llega el nuevo, asi que lo fiable es esperar el valor en la base.
    await monthlyInput(acc).locator("xpath=ancestor::form").getByRole("button", { name: "Guardar" }).click();
  };
  const monthlyOf = async (acc) => {
    const r = (await db.sql("SELECT monthlyBudgetCap FROM SocialAccount WHERE id=?", [acc]))[0].monthlyBudgetCap;
    return r === null ? null : Number(r);
  };

  // En Cuentas: el tope mensual no puede ser menor que el diario (un dia ya lo pasaria)
  await admin.goto(`${APP}/cuentas`);
  check("Cuentas muestra el gasto del mes junto al tope", (await admin.getByText(/Este mes:/).count()) >= 1);
  await monthlyInput(ACC_COP).fill("10.000");
  await submitCaps(ACC_COP);
  await admin.getByText(/no puede ser menor que el diario/).waitFor();
  check("un tope mensual menor que el diario se rechaza", (await monthlyOf(ACC_COP)) === null);
  const roomFor = (extra) => String(Math.ceil(S) + extra);
  await monthlyInput(ACC_COP).fill(roomFor(100_000));
  await submitCaps(ACC_COP);
  await until(async () => (await monthlyOf(ACC_COP)) === Math.ceil(S) + 100_000);
  check("el tope mensual se guarda (y queda en la auditoría)", (await monthlyOf(ACC_COP)) === Math.ceil(S) + 100_000 && (await db.sql("SELECT COUNT(*) c FROM AuditLog WHERE action='ads.monthly_cap_set'"))[0].c > 0n, String(await monthlyOf(ACC_COP)));

  // Un anuncio de 20.000 x 7 dias (140.000) no cabe en los 100.000 que quedan del mes
  await openBoost(edgar, FB, { name: "Mensual 1", budget: "20000", days: 7 });
  await edgar.getByText(/Tope mensual de esta cuenta/).first().waitFor();
  await submit(edgar);
  const m1 = await waitCreated(edgar);
  await aura.goto(`${APP}/anuncios/creados/${m1}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  const monthlyMsg = await aura.getByText(/Superaría el tope mensual de la cuenta/).first().innerText();
  const m1Row = await promo(m1);
  check("activar un anuncio que no cabe en lo que queda del mes se rechaza y explica las partes (gastado y este anuncio)", /ya se gastaron/.test(monthlyMsg) && /este anuncio puede gastar hasta/.test(monthlyMsg) && /Baja el presupuesto/.test(monthlyMsg), monthlyMsg);
  check("y no se toca nada en Meta", m1Row.status === "PAUSED" && metaAds().campaigns.find((c) => c.id === m1Row.metaCampaignId).status === "PAUSED");

  // Al subir el tope mensual, se activa
  await db.sql("UPDATE SocialAccount SET monthlyBudgetCap=? WHERE id=?", [Math.ceil(S) + 1_000_000, ACC_COP]);
  await aura.goto(`${APP}/anuncios/creados/${m1}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  check("con tope mensual suficiente, se activa", await until(async () => (await promo(m1)).status === "ACTIVE"));

  // Lo comprometido por otros anuncios activos cuenta: el cupo alcanza para UNO mas de 20.000 x lo que queda del mes, no para dos
  const daysLeft = (() => {
    const [y, m, d] = bogotaToday.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate() - d + 1;
  })();
  const oneAd = 20_000 * Math.min(7, daysLeft);
  await db.sql("UPDATE SocialAccount SET monthlyBudgetCap=? WHERE id=?", [Math.ceil(S) + oneAd + 1, ACC_COP]);
  await openBoost(edgar, FB, { name: "Mensual 2", budget: "20000", days: 7 });
  await submit(edgar);
  const m2 = await waitCreated(edgar);
  await aura.goto(`${APP}/anuncios/creados/${m2}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  const committedMsg = await aura.getByText(/Superaría el tope mensual de la cuenta/).first().innerText();
  check("lo que ya tiene comprometido otro anuncio activo cuenta contra el tope mensual", /otros anuncios activos pueden gastar hasta/.test(committedMsg) && (await promo(m2)).status === "PAUSED", committedMsg);

  // Subir el presupuesto de uno activo tambien se comprueba
  await aura.goto(`${APP}/anuncios/creados/${m1}`);
  await aura.locator("#nuevo-presupuesto").fill("50.000");
  await aura.getByRole("button", { name: "Cambiar", exact: true }).click();
  await aura.getByText(/Superaría el tope mensual de la cuenta/).first().waitFor();
  check("subir el presupuesto de un anuncio activo por encima del cupo mensual se rechaza", Number((await promo(m1)).dailyBudget) === 20000);

  // Lo ya existente en Meta tambien se comprueba contra el tope mensual
  await db.sql("UPDATE SocialAccount SET monthlyBudgetCap=? WHERE id=?", [Math.ceil(S) + 50_000, ACC_COP]);
  await aura.goto(`${APP}/anuncios/campanas?cuenta=${ACC_COP}`);
  const extRow = aura.locator("table tr", { hasText: "Campaña externa" }).first();
  aura.once("dialog", (d) => d.accept());
  await extRow.getByRole("button", { name: "Activar" }).click();
  await extRow.getByText(/Superaría el tope mensual de la cuenta/).waitFor();
  check("activar una campaña existente que no cabe en el mes se rechaza", metaAds().campaigns.find((c) => c.id === external.campaign).status === "PAUSED");

  // Freno automatico: si el gasto del mes llega al tope, se pausan los anuncios activos de la app
  await db.sql("UPDATE SocialAccount SET monthlyBudgetCap=? WHERE id=?", [Math.max(Math.floor(S), 50_000), ACC_COP]);
  check("al llegar el gasto del mes al tope mensual, el worker PAUSA los anuncios activos de la app", await until(async () => (await promo(m1)).status === "PAUSED", 30_000));
  // El registro de auditoría se escribe justo después de pausar: se espera a que esté antes de comprobarlo.
  await until(async () => (await db.sql("SELECT COUNT(*) c FROM AuditLog WHERE action='ads.paused_by_cap'"))[0].c > BigInt(0));
  const braked = await promo(m1);
  check("y los deja pausados también en Meta", metaAds().campaigns.find((c) => c.id === braked.metaCampaignId).status === "PAUSED" && metaAds().ads.find((x) => x.id === braked.metaAdId).status === "PAUSED");
  check("con una nota que explica por qué, y queda en la auditoría", /Se pausó automáticamente: el gasto de .* llegó al tope mensual/.test(braked.error ?? "") && (await db.sql("SELECT COUNT(*) c FROM AuditLog WHERE action='ads.paused_by_cap'"))[0].c > 0n, String(braked.error));
  await aura.goto(`${APP}/anuncios/creados/${m1}`);
  check("la ficha muestra esa nota", (await aura.getByText(/Se pausó automáticamente/).count()) === 1);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  await aura.getByText(/Superaría el tope mensual de la cuenta/).first().waitFor();
  check("y con el tope alcanzado no se puede volver a activar", (await promo(m1)).status === "PAUSED");

  // Quitar el tope mensual lo deja sin limite mensual (queda solo el diario)
  await admin.goto(`${APP}/cuentas`);
  await monthlyInput(ACC_COP).fill("");
  await submitCaps(ACC_COP);
  await until(async () => (await monthlyOf(ACC_COP)) === null);
  check("quitar el tope mensual lo deja sin tope (queda el diario)", (await monthlyOf(ACC_COP)) === null && (await capOf(ACC_COP)) === 50000);
  await aura.goto(`${APP}/anuncios/creados/${m2}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Activar anuncio" }).click();
  check("sin tope mensual se activa con solo el tope diario", await until(async () => (await promo(m2)).status === "ACTIVE"));
  await aura.goto(`${APP}/anuncios/creados/${m2}`);
  await aura.getByRole("button", { name: "Pausar", exact: true }).click();
  check("y se deja en pausa para no arrastrar gasto a lo que sigue", await until(async () => (await promo(m2)).status === "PAUSED"));

  // ------------------------------------------------------------ 10. permisos, listas y diseño
  await vera.goto(`${APP}/anuncios/nuevo`);
  check("solo lectura no entra a crear anuncios", !vera.url().includes("/anuncios/nuevo"));
  await aura.goto(`${APP}/anuncios/nuevo`);
  check("quien aprueba pero no crea tampoco crea anuncios", !aura.url().includes("/anuncios/nuevo"));

  await edgar.goto(`${APP}/publicaciones/${published.id}`);
  const impulsar = edgar.getByRole("link", { name: "Impulsar con un anuncio" });
  check("la ficha de una publicación publicada ofrece impulsarla (a quien puede crear anuncios)", (await impulsar.count()) >= 1);
  await impulsar.first().click();
  await edgar.waitForURL(/\/anuncios\/nuevo\?tipo=impulsar&destino=/);
  check("y el formulario llega con esa publicación elegida", (await edgar.locator("#fuente").inputValue()) !== "");
  await aura.goto(`${APP}/publicaciones/${published.id}`);
  check("quien no crea anuncios no ve ese enlace", (await aura.getByRole("link", { name: "Impulsar con un anuncio" }).count()) === 0);

  await aura.goto(`${APP}/anuncios/creados`);
  await shot(aura, "anuncios-creados.png");
  check("la lista de anuncios muestra su estado", (await aura.getByText("Archivado").count()) >= 1 && (await aura.getByText("En pausa").count()) >= 1);
  check("el menú de Anuncios tiene sus tres pestañas", (await aura.getByRole("navigation", { name: "Anuncios" }).getByRole("link").allInnerTexts()).join("|") === "Rendimiento|Creados en la app|Campañas en Meta");

  // Permiso que falta en la conexión
  await db.sql("UPDATE SocialAccount SET scopes=? WHERE id=?", [NO_WRITE_SCOPES, ACC_USD]);
  await admin.goto(`${APP}/cuentas`);
  check("una cuenta sin ads_management avisa y enlaza al Manual", (await admin.getByText(/Sin permiso para crear anuncios \(falta ads_management\)/).count()) === 1);
  await edgar.goto(`${APP}/anuncios/nuevo?tipo=impulsar&destino=${FB}`);
  check("y no se ofrece para crear anuncios", (await edgar.locator("#cuenta option[disabled]").count()) === 1);
  await db.sql("UPDATE SocialAccount SET scopes=? WHERE id=?", [FULL_SCOPES, ACC_USD]);

  // El Manual explica los anuncios y su estado ahora lo refleja
  await admin.goto(`${APP}/manual`);
  check("el Manual explica los anuncios y está en su índice", (await admin.locator("#anuncios").getByRole("heading", { name: "8. Anuncios: crear, activar y controlar el gasto" }).count()) === 1 && (await admin.locator('nav[aria-label="En esta guía"] a[href="#anuncios"]').count()) === 1);
  const anunciosText = await admin.locator("#anuncios").innerText();
  check("el Manual explica cómo configurar el medio de pago y el tope mensual", /Cómo configurar el medio de pago en Meta/.test(anunciosText) && /Facturación y pagos/.test(anunciosText) && /límite de gasto de la cuenta/.test(anunciosText) && /tope mensual/.test(anunciosText));
  check("«Tu estado ahora» confirma que se pueden crear anuncios cuando hay permiso y tope", (await admin.getByText("Se pueden crear anuncios").count()) === 1);
  check("la línea recomendada de META_SCOPES incluye ads_management", (await admin.getByText(/META_SCOPES="ads_read,ads_management,/).count()) >= 1);
  check("«Tu estado ahora» avisa que hay imágenes registradas cuyo archivo no está en este servidor", (await admin.getByText(/imágenes registradas no están en la carpeta de este servidor/).count()) === 1);
  await setCap(ACC_USD, null);
  await admin.goto(`${APP}/manual`);
  check("sin tope en una cuenta, el estado lo avisa y manda al paso", (await admin.getByText(/1 cuenta\(s\) publicitaria\(s\) sin tope de gasto diario/).count()) === 1);
  await setCap(ACC_USD, 10.5);

  // ------------------------------------------------------------ 11. secretos, errores y diseño
  const secrets = (await db.sql("SELECT accessTokenEnc FROM SocialAccount")).map((r) => r.accessTokenEnc).concat([LONG_TOKEN, PAGE_TOKEN, APP_SECRET, "accessTokenEnc"]);
  const html = [];
  for (const u of ["/anuncios/creados", `/anuncios/creados/${fbId}`, `/anuncios/campanas?cuenta=${ACC_COP}`, `/anuncios/nuevo?tipo=impulsar&destino=${FB}`, "/cuentas"]) html.push(await (await adminCtx.request.get(`${APP}${u}`)).text());
  check("ninguna pantalla contiene tokens, secretos ni su versión cifrada", !secrets.some((s) => html.join("\n").includes(s)));
  check("la auditoría de anuncios no contiene tokens", !JSON.stringify(await db.sql("SELECT detail FROM AuditLog")).includes(LONG_TOKEN));
  const actions = new Set((await db.sql("SELECT action FROM AuditLog")).map((a) => a.action));
  check("la auditoría registra crear, activar, pausar, presupuesto, archivar y lo existente", ["ads.created", "ads.create_failed", "ads.activated", "ads.paused", "ads.budget_changed", "ads.archived", "ads.existing_activated", "ads.existing_budget_changed"].every((k) => actions.has(k)), [...actions].join(","));
  check("el worker no registró errores internos en toda la prueba", !logs.some((l) => /error interno|fallo la vuelta|fallo una vuelta|\[anuncios\] (crear|activar|fallo)/.test(l)), logs.filter((l) => /error interno|fallo la vuelta|\[anuncios\]/.test(l)).slice(0, 3).join(" | "));
  check("al final no hay nada ACTIVO en Meta salvo lo que se activó a propósito", metaAds().campaigns.filter((c) => c.status === "ACTIVE").length === 0);

  const { page: mob } = await newPage({ width: 390, height: 844 }, { deviceScaleFactor: 2 });
  await loginAs(mob, USERS.edgar);
  for (const [u, name] of [["/anuncios/nuevo?tipo=impulsar", "anuncio-nuevo-movil.png"], ["/anuncios/creados", "anuncios-creados-movil.png"], [`/anuncios/campanas?cuenta=${ACC_COP}`, "campanas-movil.png"]]) {
    await mob.goto(`${APP}${u}`);
    await mob.waitForLoadState("networkidle");
    const overflow = await mob.evaluate(() => {
      const w = window.innerWidth;
      const bad = [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > w + 1 && !(el.parentElement && el.parentElement.closest(".overflow-x-auto"))).slice(0, 6).map((el) => `${el.tagName}.${String(el.className).slice(0, 60)} -> ${Math.round(el.getBoundingClientRect().right)}`);
      const chain = []; for (let el = document.querySelector("table"); el && el !== document.documentElement; el = el.parentElement) chain.push(`${el.tagName.toLowerCase()}:${Math.round(el.getBoundingClientRect().width)}/${el.scrollWidth}`);
      return { ok: document.documentElement.scrollWidth <= w, bad: bad.concat([`html:${document.documentElement.scrollWidth} chain ${chain.join(" < ")}`]) };
    });
    check(`en el móvil ${u.split("?")[0]} no tiene scroll horizontal`, overflow.ok, overflow.bad.join(" | "));
    await shot(mob, name);
  }
  const { page: dark } = await newPage({ width: 1280, height: 1000 }, { colorScheme: "dark" });
  await loginAs(dark, USERS.aura);
  await dark.goto(`${APP}/anuncios/creados/${capId}`);
  await shot(dark, "anuncio-detalle-oscuro.png");
  void before;
  void noImage;
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
