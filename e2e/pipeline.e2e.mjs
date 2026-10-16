// Prueba de extremo a extremo de la Fase 3b/3c: imagen, revision y aprobacion, programacion, publicacion en
// segundo plano (worker), reintentos, fallos, calendario y permisos, contra un Meta SIMULADO (fake-meta.mjs).
// No publica nada real. Arranca la app dos veces (hace falta `npm run build`):
//   - A: con el worker encendido (revisa cada segundo) y direccion publica para las imagenes de Instagram.
//   - B: sin worker y SIN direccion publica (APP_URL local): sirve para el choque de procesos y el aviso de Instagram.
// VACIA la base de pruebas (solo corre contra una base *_test).

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";
import { APP_ID, APP_SECRET, PAGE_TOKEN, startFakeMeta } from "./fake-meta.mjs";
import { createChecker, createDb, findChrome, requireTestDb, startApp, waitFor, waitReady } from "./helpers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_PORT = Number(process.env.E2E_PIPELINE_PORT ?? 3320);
const PLAIN_PORT = APP_PORT + 1;
const FAKE_PORT = Number(process.env.E2E_FAKE_META_PORT ?? 4030);
const APP = `http://localhost:${APP_PORT}`;
const PLAIN = `http://localhost:${PLAIN_PORT}`;
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
const TZ_RES = "America/Bogota";
const TZ_SMA = "America/New_York";

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

/** JPEG minimo con un SOF0 que declara el tamano (la app solo lee la cabecera). */
function jpeg(width, height) {
  const parts = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)];
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, ...Array(9).fill(0), 0xff, 0xd9);
  return Buffer.from(parts);
}
/** PNG de verdad (RGBA, con una franja transparente) que Chrome puede decodificar; el de abajo solo tiene cabecera. */
function realPng(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const rowLen = width * 4 + 1;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * rowLen + 1 + x * 4;
      raw[o] = (x * 255) / width; // rojo
      raw[o + 1] = (y * 255) / height; // verde
      raw[o + 2] = 120; // azul
      raw[o + 3] = y < height / 4 ? 0 : 255; // la franja de arriba es transparente
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function png(width, height) {
  const b = Buffer.alloc(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.writeUInt32BE(13, 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tag = () => randomBytes(3).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fecha y hora "de pared" de un instante en una zona: { day: "2026-10-16", time: "09:00" }. */
function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}

// Expresiones SQL para fechas: se guardan en UTC, igual que hace la app (nunca pasar objetos Date al conector).
const inMinutes = (m) => `DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${Number(m)} MINUTE)`;
const atUtc = (d) => `'${d.toISOString().slice(0, 19).replace("T", " ")}'`;
const ISO = "%Y-%m-%dT%H:%i:%sZ";

const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "redes-e2e-media-"));
const mediaFiles = () => fs.readdirSync(MEDIA_DIR);
let counter = 0;

/** Crea una publicacion directamente en la base (para no repetir el editor en cada caso). */
async function makePost({ brand = BRAND_RES, status = "DRAFT", text, link = null, scheduled = null, published = null, targets = ["acc-fb-reservi"], targetStatus = "PENDING", locked = null, image = null, by = USERS.edgar.id }) {
  const id = `post-${String(++counter).padStart(4, "0")}`;
  text ??= `Prueba ${id} ${tag()}`;
  // La fecha se pone al final: con el worker corriendo, una publicacion vencida a medio crear se publicaria incompleta.
  await db.sql(
    "INSERT INTO Post (id, brandId, text, linkUrl, status, scheduledAt, publishedAt, createdById, aiGenerated, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, NOW(3), NOW(3))",
    [id, brand, text, link, status, by],
  );
  for (const acc of targets) {
    await db.sql(`INSERT INTO PostTarget (id, postId, accountId, status, attempts, lockedAt) VALUES (?, ?, ?, ?, 0, ${locked ?? "NULL"})`, [`${id}-${acc}`, id, acc, targetStatus]);
  }
  let storageKey = null;
  if (image) {
    storageKey = `${randomBytes(24).toString("hex")}.${image === "png" ? "png" : "jpg"}`;
    const bytes = image === "png" ? png(800, 800) : jpeg(1080, 1350);
    if (image !== "missing") fs.writeFileSync(path.join(MEDIA_DIR, storageKey), bytes);
    await db.sql(
      "INSERT INTO PostMedia (id, postId, mimeType, size, width, height, storageKey, originalName, position, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(3))",
      [`${id}-m`, id, image === "png" ? "image/png" : "image/jpeg", 100, image === "png" ? 800 : 1080, image === "png" ? 800 : 1350, storageKey, "foto.jpg"],
    );
  }
  if (scheduled || published) {
    await db.sql(`UPDATE Post SET scheduledAt = ${scheduled ?? "NULL"}, publishedAt = ${published ?? "NULL"} WHERE id=?`, [id]);
  }
  return { id, text, storageKey };
}

/** Agrega n imagenes JPG (archivo + fila) a una publicacion, en orden y distintas entre si. */
async function addImages(postId, n, { w = 1080, h = 1350 } = {}) {
  const keys = [];
  for (let i = 0; i < n; i++) {
    const key = `${randomBytes(24).toString("hex")}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, key), jpeg(w, h + i));
    await db.sql(
      "INSERT INTO PostMedia (id, postId, mimeType, size, width, height, storageKey, originalName, position, createdAt) VALUES (?, ?, 'image/jpeg', 100, ?, ?, ?, ?, ?, NOW(3))",
      [`${postId}-x${i}`, postId, w, h + i, key, `f${i}.jpg`, i],
    );
    keys.push(key);
  }
  return keys;
}

const postRow = async (id) =>
  (await db.sql(`SELECT status, DATE_FORMAT(scheduledAt, '${ISO}') AS scheduledAt, DATE_FORMAT(publishedAt, '${ISO}') AS publishedAt, reviewNote, reviewedById FROM Post WHERE id=?`, [id]))[0];
const targetsOf = async (id) =>
  (await db.sql("SELECT accountId, status, attempts, error, externalId, externalUrl, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), nextAttemptAt) AS retryIn FROM PostTarget WHERE postId=? ORDER BY accountId", [id])).map((t) => ({
    ...t,
    attempts: Number(t.attempts),
    retryIn: t.retryIn === null ? null : Number(t.retryIn),
  }));
const waitPost = (id, wanted, timeout = 40_000) =>
  waitFor(async () => (wanted.includes((await postRow(id)).status) ? true : null), { timeout, interval: 400 });
const waitTarget = (id, account, pred, timeout = 40_000) =>
  waitFor(async () => ((await targetsOf(id)).find((t) => t.accountId === account && pred(t)) ? true : null), { timeout, interval: 400 });
/** Adelanta el reintento de un destino como si ya hubiera pasado el tiempo de espera. */
const dueNow = (id) => db.sql(`UPDATE PostTarget SET nextAttemptAt = ${inMinutes(-1)} WHERE postId=? AND status='PENDING'`, [id]);

let fake;
let appA;
let appB;
let browser;
const logs = [];
const contexts = [];
try {
  await db.reset();
  fake = await startFakeMeta(FAKE_PORT, `${APP}/api/meta/callback`);
  const calm = () => fake.setScenario({ publishFail: {}, flaky: {}, igProcessing: 0, igContainer: "ok" });

  const baseEnv = {
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
    // Como un VPS tipico: el servidor trabaja en UTC y la app tiene que mostrar las horas en la zona de la app (Bogota).
    TZ: "UTC",
    APP_TIMEZONE: "",
  };
  appA = startApp({
    root: ROOT,
    port: APP_PORT,
    logs,
    env: { ...baseEnv, APP_URL: APP, MEDIA_PUBLIC_BASE_URL: `http://127.0.0.1:${APP_PORT}`, WORKER_ENABLED: "true", WORKER_INTERVAL_SECONDS: "1" },
  });
  appB = startApp({ root: ROOT, port: PLAIN_PORT, logs, env: { ...baseEnv, APP_URL: PLAIN, MEDIA_PUBLIC_BASE_URL: "", WORKER_ENABLED: "false" } });
  await Promise.all([waitReady(APP), waitReady(PLAIN)]);

  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
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
  const anon = (url) => fetch(url, { redirect: "manual" });

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
    await db.sql(
      "INSERT INTO User (id, email, name, passwordHash, role, active, failedLogins, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 0, NOW(3), NOW(3))",
      [u.id, u.email, u.name, bcrypt.hashSync(u.pass, 4), u.role],
    );
  }
  for (const [id, name, tz] of [[BRAND_RES, "Reservi", TZ_RES], [BRAND_SMA, "Smartec", TZ_SMA]]) {
    await db.sql("INSERT INTO Brand (id, name, description, language, timezone, createdAt, updatedAt) VALUES (?, ?, ?, 'es', ?, NOW(3), NOW(3))", [
      id,
      name,
      "Negocio de prueba para las publicaciones automáticas.",
      tz,
    ]);
  }
  const account = (id, kind, ext, name, token, brandId, handle = null) =>
    db.sql(
      "INSERT INTO SocialAccount (id, platform, kind, externalId, name, handle, status, accessTokenEnc, brandId, createdAt, updatedAt) VALUES (?, 'META', ?, ?, ?, ?, 'ACTIVE', ?, ?, NOW(3), NOW(3))",
      [id, kind, ext, name, handle, encrypt(token), brandId],
    );
  await account("acc-fb-reservi", "FACEBOOK_PAGE", "P-1", "Mi Marca", PAGE_TOKEN, BRAND_RES);
  await account("acc-ig-reservi", "INSTAGRAM_PROFILE", "IG-1", "Mi Marca Oficial", PAGE_TOKEN, BRAND_RES, "@mimarca");
  await account("acc-fb-smartec", "FACEBOOK_PAGE", "P-2", "Smartec", "PAGE-TOKEN-2222", BRAND_SMA);

  check("el worker arrancó en A con la frecuencia pedida", await waitFor(async () => logs.some((l) => l.startsWith(`[:${APP_PORT}]`) && l.includes("[worker] activo: revisa publicaciones cada 1 s")), { timeout: 15_000, interval: 300 }));
  check("WORKER_ENABLED=false mantiene apagado el worker de B", !logs.some((l) => l.startsWith(`[:${PLAIN_PORT}]`) && l.includes("[worker] activo")));

  // ------------------------------------------------------------ 1. borrador con imagen (editor)
  const { ctx: edgarCtx, page: edgar } = await newPage();
  await loginAs(edgar, USERS.edgar);
  await edgar.goto(`${APP}/publicaciones/nueva?marca=${BRAND_RES}`);
  check("el editor ve los 2 destinos de la marca (y no los de otra)", (await edgar.locator('input[name="targetId"]').count()) === 2);
  const mainText = `Reservas sin llamadas ✅\nAhora también en Instagram, ¡pruébalo! #reservi ${tag()}`;
  await edgar.locator("#text").fill(mainText);
  await edgar.locator('input[name="targetId"][value="acc-fb-reservi"]').check();
  await edgar.locator('input[name="targetId"][value="acc-ig-reservi"]').check();
  await edgar.getByRole("button", { name: "Guardar borrador" }).click();
  await edgar.waitForURL(/\/publicaciones\/[^/]+\?guardada=1/);
  const mainId = edgar.url().match(/publicaciones\/([^/?]+)/)[1];
  check("el borrador se guardó con sus 2 destinos", (await targetsOf(mainId)).length === 2);

  const file = (name, mimeType, buffer) => ({ name, mimeType, buffer });
  await edgar.locator("#media-file").setInputFiles(file("foto.jpg", "image/jpeg", Buffer.from("no soy una imagen, solo me llamo .jpg")));
  await edgar.getByText("El archivo no es una imagen JPG o PNG.").waitFor();
  check("un archivo que solo se llama .jpg se rechaza por su contenido", Number((await db.sql("SELECT COUNT(*) c FROM PostMedia WHERE postId=?", [mainId]))[0].c) === 0 && mediaFiles().length === 0);

  await edgar.locator("#media-file").setInputFiles(file("cuadro.png", "image/png", png(800, 800)));
  await edgar.getByAltText("Imagen de la publicación").waitFor();
  const pngRow = (await db.sql("SELECT mimeType, width, height, storageKey FROM PostMedia WHERE postId=?", [mainId]))[0];
  check("un PNG válido se guarda con su tamaño y nombre aleatorio", pngRow?.mimeType === "image/png" && pngRow.width === 800 && /^[a-f0-9]{48}\.png$/.test(pngRow.storageKey) && mediaFiles().includes(pngRow.storageKey));

  await edgar.getByRole("button", { name: "Enviar a revisión" }).click();
  await edgar.getByText(/Instagram solo acepta imágenes JPG/).waitFor();
  check("con Instagram como destino, un PNG no pasa a revisión y se explica por qué", (await postRow(mainId)).status === "DRAFT");

  await edgar.getByRole("button", { name: "Quitar imagen" }).click();
  await waitFor(async () => Number((await db.sql("SELECT COUNT(*) c FROM PostMedia WHERE postId=?", [mainId]))[0].c) === 0, { timeout: 15_000 });
  check("quitar la imagen borra el registro y el archivo", mediaFiles().length === 0);

  // Un PNG de verdad se convierte solo a JPG en el navegador (Instagram no acepta PNG) y conserva su tamaño.
  await edgar.locator("#media-file").setInputFiles(file("captura.png", "image/png", realPng(400, 500)));
  await edgar.getByAltText("Imagen de la publicación").waitFor();
  const conv = (await db.sql("SELECT mimeType, width, height, storageKey, originalName FROM PostMedia WHERE postId=?", [mainId]))[0];
  const convBytes = fs.readFileSync(path.join(MEDIA_DIR, conv.storageKey));
  check("un PNG real se sube convertido a JPG, con el mismo tamaño y el nombre cambiado", conv.mimeType === "image/jpeg" && conv.width === 400 && conv.height === 500 && /\.jpg$/.test(conv.storageKey) && conv.originalName === "captura.jpg" && convBytes[0] === 0xff && convBytes[1] === 0xd8);
  check("y avisa que lo convirtió", await edgar.getByText(/Convertimos tu PNG a JPG/).isVisible());
  await edgar.getByRole("button", { name: "Quitar imagen" }).click();
  await waitFor(async () => Number((await db.sql("SELECT COUNT(*) c FROM PostMedia WHERE postId=?", [mainId]))[0].c) === 0, { timeout: 15_000 });
  check("al quitar la imagen desaparece también el aviso de conversión", (await edgar.getByText(/Convertimos tu PNG a JPG/).count()) === 0 && mediaFiles().length === 0);

  const mainJpg = jpeg(1080, 1350);
  await edgar.locator("#media-file").setInputFiles(file("portada.jpg", "image/jpeg", mainJpg));
  await edgar.getByAltText("Imagen de la publicación").waitFor();
  const jpgRow = (await db.sql("SELECT storageKey, size FROM PostMedia WHERE postId=?", [mainId]))[0];
  check("un JPG 4:5 se guarda tal cual", jpgRow && /^[a-f0-9]{48}\.jpg$/.test(jpgRow.storageKey) && Number(jpgRow.size) === mainJpg.length && sha(fs.readFileSync(path.join(MEDIA_DIR, jpgRow.storageKey))) === sha(mainJpg));
  const mainKey = jpgRow.storageKey;

  const mediaUrl = `${APP}/api/posts/${mainId}/media`;
  const full = await makePost({ status: "DRAFT", targets: ["acc-fb-reservi"] });
  await addImages(full.id, 10);
  const eleventh = await edgarCtx.request.post(`${APP}/api/posts/${full.id}/media`, { multipart: { file: file("once.jpg", "image/jpeg", jpeg(1080, 1080)) }, headers: { origin: APP } });
  check("una publicación admite hasta 10 imágenes: la 11.ª se rechaza y dice el límite", eleventh.status() === 409 && /hasta 10 imágenes/.test((await eleventh.json()).error));
  await edgar.goto(`${APP}/publicaciones/${full.id}`);
  check("con 10 imágenes la pantalla ya no ofrece subir más", (await edgar.locator("#media-file").count()) === 0 && (await edgar.getByText(/Llegaste al máximo de 10 imágenes/).count()) === 1);
  await edgar.goto(`${APP}/publicaciones/${mainId}`);
  const cross = await edgarCtx.request.post(mediaUrl, { multipart: { file: file("x.jpg", "image/jpeg", jpeg(1080, 1080)) }, headers: { origin: "https://evil.example" } });
  check("una subida desde otro origen se rechaza", cross.status() === 403);
  const noSession = await fetch(mediaUrl, { method: "POST", redirect: "manual", headers: { origin: APP }, body: (() => { const f = new FormData(); f.set("file", new Blob([mainJpg], { type: "image/jpeg" }), "x.jpg"); return f; })() });
  check("sin sesión, subir una imagen da un 401 claro (no un redirect ni un error del servidor)", noSession.status === 401 && /sesión expiró/.test(await noSession.text()), String(noSession.status));
  check("sin sesión, una navegación sí se manda a iniciar sesión", await (async () => { const r = await anon(`${APP}/publicaciones`); return r.status === 307 && (r.headers.get("location") ?? "").endsWith("/login"); })());

  check("un borrador no tiene imagen pública", (await anon(`${APP}/media/${mainKey}`)).status === 404);
  check("un archivo con nombre inventado o con '..' no se sirve", (await anon(`${APP}/media/${"a".repeat(48)}.jpg`)).status === 404 && (await anon(`${APP}/media/..%2F..%2F.env`)).status === 404);

  // ------------------------------------------------------------ 2. revision y aprobacion
  await edgar.getByRole("button", { name: "Enviar a revisión" }).click();
  check("el borrador completo pasa a revisión", await waitFor(async () => ((await postRow(mainId)).status === "IN_REVIEW" ? true : null), { timeout: 15_000 }));
  await edgar.reload();
  check("quien la envió ve el estado pero no puede aprobar ni programar", (await edgar.getByText("En revisión").first().isVisible()) && (await edgar.getByRole("heading", { name: "Aprobar" }).count()) === 0 && (await edgar.getByRole("heading", { name: "Programar" }).count()) === 0);
  check("en revisión la imagen sigue sin ser pública", (await anon(`${APP}/media/${mainKey}`)).status === 404);

  const { ctx: auraCtx, page: aura } = await newPage();
  await loginAs(aura, USERS.aura);
  await aura.goto(`${APP}/publicaciones/${mainId}`);
  check("la persona que aprueba ve el texto, la imagen y sus acciones", (await aura.getByAltText("Imagen de la publicación").isVisible()) && (await aura.getByRole("heading", { name: "Aprobar" }).isVisible()) && (await aura.getByRole("heading", { name: "Devolver con una nota" }).isVisible()));
  check("el texto con saltos de línea, acentos y emoji se muestra íntegro", (await aura.locator("main").innerText()).includes("Reservas sin llamadas ✅"));
  await aura.getByRole("button", { name: "Devolver al editor" }).click();
  await aura.getByText(/Explica qué hay que cambiar/).waitFor();
  check("devolver sin nota se rechaza", (await postRow(mainId)).status === "IN_REVIEW");
  await aura.locator("#return-note").fill("Cambia el primer renglón, suena a promesa exagerada.");
  await aura.getByRole("button", { name: "Devolver al editor" }).click();
  check("devolver con nota vuelve la publicación a borrador", await waitFor(async () => ((await postRow(mainId)).status === "DRAFT" ? true : null), { timeout: 15_000 }));
  const returned = await postRow(mainId);
  check("la nota y quién la dejó quedan guardadas", returned.reviewNote?.startsWith("Cambia el primer renglón") && returned.reviewedById === USERS.aura.id);

  await edgar.reload();
  check("el editor ve la nota de devolución", await edgar.getByText(/Devuelta por Aura Aprobadora:/).isVisible());
  await edgar.locator("#text").fill(`Reservas sin llamadas ✅\nAhora también en Instagram. #reservi ${tag()}`);
  await edgar.getByRole("button", { name: "Guardar cambios" }).click();
  await waitFor(async () => (await db.sql("SELECT text FROM Post WHERE id=?", [mainId]))[0].text !== mainText, { timeout: 15_000 });
  const finalText = (await db.sql("SELECT text FROM Post WHERE id=?", [mainId]))[0].text;
  await edgar.getByRole("button", { name: "Enviar a revisión" }).click();
  check("tras corregir, el editor vuelve a enviarla", await waitFor(async () => ((await postRow(mainId)).status === "IN_REVIEW" ? true : null), { timeout: 15_000 }));

  // La acción de servidor se captura mientras la persona que aprueba la usa, y se reproduce sin permiso.
  const victim = await makePost({ status: "IN_REVIEW", targets: ["acc-fb-reservi"] });
  let captured = null;
  const grab = (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) captured = { url: r.url(), headers: r.headers(), body: r.postDataBuffer() };
  };

  await aura.goto(`${APP}/publicaciones/${mainId}`);
  const tomorrow = localParts(new Date(Date.now() + 86_400_000), TZ_RES).day;
  const soon = localParts(new Date(Date.now() + 30_000), TZ_RES);
  await aura.locator("#when-a").fill(`${soon.day}T${soon.time}`);
  await aura.getByRole("button", { name: "Aprobar", exact: true }).click();
  await aura.getByText(/al menos dentro de 2 minutos/).waitFor();
  check("programar para dentro de menos de 2 minutos se rechaza", (await postRow(mainId)).status === "IN_REVIEW");

  await aura.locator("#when-a").fill(`${tomorrow}T09:00`);
  await aura.locator("#approve-note").fill("Listo, sale mañana.");
  aura.on("request", grab);
  await aura.getByRole("button", { name: "Aprobar", exact: true }).click();
  check("aprobar con fecha la deja programada", await waitFor(async () => ((await postRow(mainId)).status === "SCHEDULED" ? true : null), { timeout: 15_000 }));
  aura.off("request", grab);
  const scheduled = await postRow(mainId);
  check("la hora escrita en la zona de la marca se guarda en UTC (9:00 en Bogotá = 14:00 UTC)", scheduled.scheduledAt === `${tomorrow}T14:00:00Z`, scheduled.scheduledAt);
  check("la nota de aprobación y quién aprobó quedan guardadas", (await postRow(mainId)).reviewedById === USERS.aura.id);

  await aura.reload();
  check("la página muestra la hora programada en la zona de la marca", (await aura.locator("main").innerText()).match(/9:00/) !== null && (await aura.getByText(/hora de America\/Bogota/).isVisible()));
  check("al reprogramar, el campo parte de la hora actual de la publicación (no de «dentro de una hora»)", (await aura.locator("#when-s").inputValue()) === `${tomorrow}T09:00`);
  const createdIso = (await db.sql(`SELECT DATE_FORMAT(createdAt, '${ISO}') AS c FROM Post WHERE id=?`, [mainId]))[0].c;
  const createdLocal = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short", timeZone: TZ_RES }).format(new Date(createdIso));
  check("las fechas de la ficha salen en la zona de la app (Bogotá) aunque el servidor trabaje en UTC", (await aura.locator("main").innerText()).includes(`Creada ${createdLocal}`), createdLocal);
  await shot(aura, "publicacion-programada.png");
  const publicNow = await anon(`${APP}/media/${mainKey}`);
  check("una vez programada, la imagen es pública para que Meta la descargue", publicNow.status === 200 && publicNow.headers.get("content-type") === "image/jpeg" && sha(Buffer.from(await publicNow.arrayBuffer())) === sha(mainJpg));
  check("y se sirve con nosniff y caché corta", publicNow.headers.get("x-content-type-options") === "nosniff" && /max-age=300/.test(publicNow.headers.get("cache-control") ?? ""));

  // seguridad: reproducir la acción «aprobar» capturada
  check("se capturó la petición real de la acción de servidor", !!captured?.headers["next-action"] && !!captured.body);
  if (captured) {
    const forged = Buffer.from(captured.body.toString("latin1").split(mainId).join(victim.id), "latin1");
    const hop = new Set(["cookie", "content-length", "host", "connection", "accept-encoding"]);
    const headers = Object.fromEntries(Object.entries(captured.headers).filter(([k]) => !hop.has(k)));
    const asEdgar = await edgarCtx.request.post(captured.url, { headers, data: forged });
    check("un editor no puede aprobar fabricando la petición: el servidor lo rechaza", (await asEdgar.text()).includes("No tienes permiso para hacer esto.") && (await postRow(victim.id)).status === "IN_REVIEW");
    const asAnon = await fetch(captured.url, { method: "POST", headers, body: forged, redirect: "manual" });
    await asAnon.arrayBuffer();
    check("sin sesión tampoco se puede aprobar", (await postRow(victim.id)).status === "IN_REVIEW");
  }

  await aura.locator("#when-s").fill(`${localParts(new Date(Date.now() + 2 * 86_400_000), TZ_RES).day}T10:00`);
  await aura.getByRole("button", { name: "Reprogramar", exact: true }).click();
  await aura.getByText("Programada.", { exact: true }).waitFor();
  check("se puede reprogramar", (await postRow(mainId)).scheduledAt?.endsWith("T15:00:00Z"));
  await aura.locator("#when-s").fill(`${tomorrow}T09:00`);
  await aura.getByRole("button", { name: "Reprogramar", exact: true }).click();
  await waitFor(async () => ((await postRow(mainId)).scheduledAt === `${tomorrow}T14:00:00Z` ? true : null), { timeout: 15_000 });

  // aprobar sin fecha deja la publicacion «Aprobada»
  const noDate = await makePost({ status: "IN_REVIEW" });
  await aura.goto(`${APP}/publicaciones/${noDate.id}`);
  await aura.getByRole("button", { name: "Aprobar", exact: true }).click();
  // El aviso de éxito desaparece al re-dibujarse la página con el nuevo estado: se mira la base.
  check("aprobar sin fecha la deja aprobada, a la espera de fecha", (await waitPost(noDate.id, ["APPROVED"], 15_000)) && (await postRow(noDate.id)).scheduledAt === null);

  // ------------------------------------------------------------ 3. el worker publica lo programado (Facebook + Instagram)
  calm();
  const published0 = fake.published().length;
  await db.sql(`UPDATE Post SET scheduledAt = ${inMinutes(-1)} WHERE id=?`, [mainId]);
  check("al llegar la hora, el worker publica en los 2 destinos", await waitPost(mainId, ["PUBLISHED"]));
  const mainTargets = await targetsOf(mainId);
  check("cada destino queda publicado en el primer intento con su id y enlace", mainTargets.length === 2 && mainTargets.every((t) => t.status === "PUBLISHED" && t.attempts === 1 && t.externalId && t.externalUrl && t.error === null && t.retryIn === null));
  check("los enlaces son los que devolvió Meta", mainTargets.find((t) => t.accountId === "acc-fb-reservi")?.externalUrl.startsWith("https://www.facebook.com/P-1_") && mainTargets.find((t) => t.accountId === "acc-ig-reservi")?.externalUrl.startsWith("https://www.instagram.com/p/FAKEIGM-"));
  const sent = fake.published().slice(published0);
  const photo = sent.find((p) => p.kind === "photo");
  // multipart/form-data normaliza los saltos de línea a CRLF (lo hace todo navegador al enviar un formulario): mismo texto.
  check("Facebook recibió la foto como archivo, idéntica a la subida, con el texto como pie", photo?.account === "P-1" && photo.sha256 === sha(mainJpg) && photo.mime === "image/jpeg" && photo.caption.replace(/\r\n/g, "\n") === finalText && photo.caption.includes("\n"), photo ? JSON.stringify(photo.caption) : "sin foto");
  const container = sent.find((p) => p.kind === "ig-container");
  check("Instagram recibió la URL pública de la imagen y la pudo descargar sin sesión", container?.imageUrl === `http://127.0.0.1:${APP_PORT}/media/${mainKey}` && container.fetched.status === 200 && container.fetched.sha256 === sha(mainJpg) && container.fetched.contentType === "image/jpeg");
  check("Instagram publicó el contenedor con el mismo texto", container?.caption === finalText && sent.some((p) => p.kind === "ig-publish" && p.creation === container.id));
  const posts0 = fake.requests().filter((r) => r.method === "POST");
  check("todas las publicaciones llevan appsecret_proof y el token va en el cuerpo, no en la URL", posts0.length >= 3 && posts0.every((r) => r.proofOk && !r.tokenInUrl));
  const done = await postRow(mainId);
  check("la publicación queda con su fecha de publicación", !!done.publishedAt);
  check("tras publicarse, la imagen sigue siendo accesible", (await anon(`${APP}/media/${mainKey}`)).status === 200);
  await aura.goto(`${APP}/publicaciones/${mainId}`);
  check("la ficha muestra «Publicada», los dos enlaces y el historial", (await aura.getByRole("link", { name: "Ver publicación" }).count()) === 2 && (await aura.getByText("Publicada en todos los destinos").isVisible()));
  await shot(aura, "publicacion-publicada.png");
  const auditCount = async (action, target) => Number((await db.sql("SELECT COUNT(*) c FROM AuditLog WHERE action=? AND target=?", [action, target]))[0].c);
  check("la auditoría registra cada paso del flujo", (await auditCount("post.submitted", mainId)) === 2 && (await auditCount("post.returned", mainId)) === 1 && (await auditCount("post.approved", mainId)) === 1 && (await auditCount("post.target_published", mainId)) === 2 && (await auditCount("post.published", mainId)) === 1);

  // ------------------------------------------------------------ 3b. varias imágenes: subir juntas, ordenar y publicar (Facebook: fotos adjuntas; Instagram: carrusel)
  calm();
  const multi = await makePost({ status: "DRAFT", targets: ["acc-fb-reservi", "acc-ig-reservi"] });
  await edgar.goto(`${APP}/publicaciones/${multi.id}`);
  const mrows = () => db.sql("SELECT id, originalName, storageKey, position FROM PostMedia WHERE postId=? ORDER BY position", [multi.id]);
  const names = async () => (await mrows()).map((r) => r.originalName).join();
  const manyJpg = [jpeg(1080, 1350), jpeg(1080, 1351), jpeg(1080, 1352)];
  await edgar.locator("#media-file").setInputFiles(manyJpg.map((b, i) => file(`foto-${i + 1}.jpg`, "image/jpeg", b)));
  check("elegir 3 archivos a la vez sube las 3, en el orden en que se eligieron", await waitFor(async () => ((await names()) === "foto-1.jpg,foto-2.jpg,foto-3.jpg" ? true : null), { timeout: 40_000 }) && (await mrows()).map((r) => r.position).join() === "0,1,2");
  await edgar.getByAltText("Imagen 3 de la publicación").waitFor();
  check("la primera se marca como portada y no se puede mover antes", (await edgar.getByText("1 · Portada").isVisible()) && (await edgar.getByRole("button", { name: "Mover la imagen 1 antes" }).isDisabled()) && (await edgar.getByRole("button", { name: "Mover la imagen 3 después" }).isDisabled()));

  await edgar.getByRole("button", { name: "Mover la imagen 3 antes" }).click();
  check("mover una imagen antes cambia el orden guardado (1, 3, 2)", await waitFor(async () => ((await names()) === "foto-1.jpg,foto-3.jpg,foto-2.jpg" ? true : null), { timeout: 20_000 }));
  await edgar.locator("#media-file").setInputFiles(file("foto-4.jpg", "image/jpeg", jpeg(1080, 1353)));
  check("una imagen más se agrega al final", await waitFor(async () => ((await names()) === "foto-1.jpg,foto-3.jpg,foto-2.jpg,foto-4.jpg" ? true : null), { timeout: 30_000 }));
  const removedKey = (await mrows()).find((r) => r.originalName === "foto-2.jpg").storageKey;
  await edgar.getByRole("button", { name: "Quitar imagen 3" }).click();
  check("quitar una del medio deja el orden de las demás y borra su archivo (1, 3, 4)", (await waitFor(async () => ((await names()) === "foto-1.jpg,foto-3.jpg,foto-4.jpg" ? true : null), { timeout: 20_000 })) && !mediaFiles().includes(removedKey));
  await edgar.reload();
  check("la pantalla muestra las 3 en ese orden", (await edgar.getByAltText(/Imagen \d de la publicación/).count()) === 3);
  await shot(edgar, "borrador-varias-imagenes.png");
  await edgar.setViewportSize({ width: 390, height: 900 });
  await edgar.reload();
  check("en el móvil las imágenes caben sin scroll horizontal", await edgar.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(edgar, "borrador-varias-imagenes-movil.png");
  await edgar.setViewportSize({ width: 1280, height: 900 });

  const finalRows = await mrows();
  const wantShas = finalRows.map((r) => sha(fs.readFileSync(path.join(MEDIA_DIR, r.storageKey))));
  const published1 = fake.published().length;
  await db.sql(`UPDATE Post SET status='SCHEDULED', scheduledAt = ${inMinutes(-1)} WHERE id=?`, [multi.id]);
  check("al llegar la hora, el worker publica la de varias imágenes en los 2 destinos", await waitPost(multi.id, ["PUBLISHED"]));
  const sentM = fake.published().slice(published1);
  const unpub = sentM.filter((p) => p.kind === "photo-unpublished");
  const feedM = sentM.find((p) => p.kind === "feed" && p.attached);
  check("Facebook recibió las 3 fotos SIN publicar, en el orden de la publicación e idénticas a las subidas", unpub.length === 3 && unpub.map((p) => p.sha256).join() === wantShas.join(), JSON.stringify(unpub.map((p) => p.name)));
  check("y una sola publicación que las adjunta en ese mismo orden, con el texto", !!feedM && feedM.attached.map((a) => a.sha256).join() === wantShas.join() && feedM.message.replace(/\r\n/g, "\n") === multi.text);
  check("Facebook no publicó las fotos sueltas", !sentM.some((p) => p.kind === "photo"));
  const carousel = sentM.find((p) => p.kind === "ig-carousel");
  check("Instagram recibió un carrusel con las 3 imágenes (cada hijo con su URL pública, descargable sin sesión) en orden", !!carousel && carousel.children.length === 3 && carousel.children.every((c) => c.kind === "ig-child" && c.fetched.status === 200 && c.caption === null) && carousel.children.map((c) => c.fetched.sha256).join() === wantShas.join());
  check("el pie va en el carrusel y se publicó el carrusel (no los hijos)", carousel?.caption?.replace(/\r\n/g, "\n") === multi.text && sentM.some((p) => p.kind === "ig-publish" && p.creation === carousel.id && p.carousel === true) && !sentM.some((p) => p.kind === "ig-publish" && p.carousel === false));
  const multiTargets = await targetsOf(multi.id);
  check("cada destino quedó publicado en el primer intento", multiTargets.length === 2 && multiTargets.every((t) => t.status === "PUBLISHED" && t.attempts === 1 && t.error === null));
  await aura.goto(`${APP}/publicaciones/${multi.id}`);
  check("la ficha de la publicada muestra las 3 imágenes y dice cómo salieron", (await aura.getByAltText(/Imagen \d de 3 de la publicación/).count()) === 3 && (await aura.getByText(/3 imágenes: en Facebook salen juntas y en Instagram como carrusel/).count()) === 1);

  // Si Instagram rechaza una imagen del carrusel: falla sin publicar nada y se explica.
  const multiBad = await makePost({ status: "DRAFT", targets: ["acc-ig-reservi"] });
  await addImages(multiBad.id, 3);
  fake.setScenario({ igContainer: "error" });
  const published2 = fake.published().length;
  await db.sql(`UPDATE Post SET status='SCHEDULED', scheduledAt = ${inMinutes(-1)} WHERE id=?`, [multiBad.id]);
  check("si Instagram rechaza una imagen del carrusel, la publicación falla", await waitPost(multiBad.id, ["FAILED"]));
  const badTarget = (await targetsOf(multiBad.id))[0];
  check("sin reintento y con el motivo en español", badTarget.attempts === 1 && /rechazó una de las imágenes/.test(badTarget.error ?? ""), String(badTarget.error));
  check("y no se publicó nada en Instagram", !fake.published().slice(published2).some((p) => p.kind === "ig-publish"));
  calm();

  // ------------------------------------------------------------ 3c. las que fallaron: volver a borrador para corregirlas, o borrarlas
  const failedA = await makePost({ status: "FAILED", targets: ["acc-fb-reservi"], targetStatus: "FAILED", image: "jpg" });
  await db.sql("UPDATE PostTarget SET attempts=4, error='Meta rechazó la publicación: prueba' WHERE postId=?", [failedA.id]);
  await aura.goto(`${APP}/publicaciones/${failedA.id}`);
  check("quien aprueba ve «Reintentar» en una que falló, pero no puede volver a borrador ni borrarla", (await aura.getByRole("button", { name: "Reintentar los que fallaron" }).count()) === 1 && (await aura.getByRole("button", { name: "Volver a borrador" }).count()) === 0 && (await aura.getByRole("button", { name: "Borrar" }).count()) === 0);
  await edgar.goto(`${APP}/publicaciones/${failedA.id}`);
  check("el editor ve «Volver a borrador» y «Borrar» en una que falló, y no puede reintentar ni publicar", (await edgar.getByRole("button", { name: "Volver a borrador" }).count()) === 1 && (await edgar.getByRole("button", { name: "Borrar" }).count()) === 1 && (await edgar.getByRole("button", { name: "Reintentar los que fallaron" }).count()) === 0);
  await edgar.getByRole("button", { name: "Volver a borrador" }).click();
  check("«Volver a borrador» la deja como borrador, sin fecha", await waitPost(failedA.id, ["DRAFT"], 15_000));
  const reopenedTargets = await targetsOf(failedA.id);
  check("sus destinos quedan pendientes y limpios (sin intentos ni error)", reopenedTargets.length === 1 && reopenedTargets[0].status === "PENDING" && reopenedTargets[0].attempts === 0 && reopenedTargets[0].error === null);
  await edgar.reload();
  check("y ya se puede editar: aparece el editor con su texto y su imagen", (await edgar.locator("#text").inputValue()) === failedA.text && (await edgar.getByAltText("Imagen de la publicación").count()) === 1);
  check("queda en la auditoría", (await db.sql("SELECT COUNT(*) c FROM AuditLog WHERE action='post.reopened' AND target=?", [failedA.id]))[0].c === 1n);

  const failedB = await makePost({ status: "FAILED", targets: ["acc-fb-reservi"], targetStatus: "FAILED", image: "jpg" });
  const failedBKey = (await db.sql("SELECT storageKey FROM PostMedia WHERE postId=?", [failedB.id]))[0].storageKey;
  await edgar.goto(`${APP}/publicaciones/${failedB.id}`);
  edgar.once("dialog", (d) => d.accept());
  await edgar.getByRole("button", { name: "Borrar" }).click();
  await edgar.waitForURL(`${APP}/publicaciones`);
  check("borrar una que falló la quita de la base, con sus destinos e imagen (también el archivo)", Number((await db.sql("SELECT COUNT(*) c FROM Post WHERE id=?", [failedB.id]))[0].c) === 0 && Number((await db.sql("SELECT COUNT(*) c FROM PostTarget WHERE postId=?", [failedB.id]))[0].c) === 0 && !mediaFiles().includes(failedBKey));

  const partialC = await makePost({ status: "PARTIAL", targets: ["acc-fb-reservi", "acc-ig-reservi"], targetStatus: "FAILED" });
  await db.sql("UPDATE PostTarget SET status='PUBLISHED', externalId='P-1_1', externalUrl='https://www.facebook.com/P-1_1' WHERE postId=? AND accountId='acc-fb-reservi'", [partialC.id]);
  await edgar.goto(`${APP}/publicaciones/${partialC.id}`);
  check("una que salió a medias (ya está en una red) no se puede borrar ni volver a borrador", (await edgar.getByRole("button", { name: "Borrar" }).count()) === 0 && (await edgar.getByRole("button", { name: "Volver a borrador" }).count()) === 0);

  const cancelledD = await makePost({ status: "CANCELLED", targets: ["acc-fb-reservi"] });
  await edgar.goto(`${APP}/publicaciones/${cancelledD.id}`);
  check("una cancelada sí se puede borrar", (await edgar.getByRole("button", { name: "Borrar" }).count()) === 1);

  // ------------------------------------------------------------ 4. «publicar ahora» y choque entre procesos
  // A (con worker) y B (sin worker, pero que publica al pulsar el botón) compiten por las mismas filas.
  const racers = [];
  for (let i = 0; i < 3; i++) racers.push(await makePost({ status: "APPROVED", link: i === 0 ? "https://reservi.example/promo" : null }));
  // Tres pestañas pulsan «Publicar ahora» a la vez en B, mientras el worker de A revisa cada segundo.
  await Promise.all(
    racers.map(async (r) => {
      const tab = await auraCtx.newPage();
      await tab.goto(`${PLAIN}/publicaciones/${r.id}`);
      tab.once("dialog", (d) => d.accept());
      await tab.getByRole("button", { name: "Publicar ahora" }).click();
      await waitPost(r.id, ["SCHEDULED", "PUBLISHING", "PUBLISHED"], 15_000);
      await tab.close();
    }),
  );
  const raced = await Promise.all(racers.map((r) => waitPost(r.id, ["PUBLISHED"])));
  check("«Publicar ahora» publica en segundos", raced.every(Boolean));
  const feeds = racers.map((r) => fake.published().filter((p) => p.kind === "feed" && p.message === r.text));
  check("aunque compitan dos procesos, cada publicación sale exactamente una vez", feeds.every((f) => f.length === 1));
  check("y cada destino cuenta un solo intento", (await Promise.all(racers.map((r) => targetsOf(r.id)))).every((t) => t.length === 1 && t[0].attempts === 1));
  check("el enlace de la publicación viaja a Facebook", feeds[0][0]?.link === "https://reservi.example/promo" && feeds[1][0]?.link === null);

  // ------------------------------------------------------------ 5. fallos, reintentos y cancelaciones
  const feedPosts = () => fake.requests().filter((r) => r.method === "POST" && r.path.endsWith("/feed")).length;
  const due = (opts) => makePost({ status: "SCHEDULED", scheduled: inMinutes(-1), ...opts });

  // 5a. sin permisos: no se reintenta
  fake.setScenario({ publishFail: { "P-1": "perm" } });
  const before5a = feedPosts();
  const perm = await due({});
  check("sin permisos en Meta: la publicación falla", await waitPost(perm.id, ["FAILED"]));
  const permT = (await targetsOf(perm.id))[0];
  check("el motivo está en español, menciona el permiso que falta y trae el detalle que dio Meta", permT.status === "FAILED" && permT.attempts === 1 && /pages_manage_posts/.test(permT.error ?? "") && /Detalle de Meta: \(#200\)/.test(permT.error ?? "") && permT.retryIn === null);
  await sleep(2500);
  check("un fallo de permisos no se reintenta solo", feedPosts() - before5a === 1);
  check("la cuenta sigue activa (no era un problema de conexión)", (await db.sql("SELECT status FROM SocialAccount WHERE id='acc-fb-reservi'"))[0].status === "ACTIVE");
  await aura.goto(`${APP}/publicaciones/${perm.id}`);
  check("la ficha explica el fallo y ofrece reintentar", (await aura.getByText(/falta de permisos/).isVisible()) && (await aura.getByRole("button", { name: "Reintentar los que fallaron" }).isVisible()));
  check("y enlaza al manual para saber qué hacer", (await aura.getByRole("link", { name: "Ver qué hacer" }).first().getAttribute("href")) === "/manual#problemas");
  await shot(aura, "publicacion-fallida.png");

  // 5b. reintentar a mano tras arreglar el problema
  calm();
  await aura.getByRole("button", { name: "Reintentar los que fallaron" }).click();
  check("al reintentar con el problema resuelto, se publica", await waitPost(perm.id, ["PUBLISHED"]));
  check("sale una sola vez", fake.published().filter((p) => p.kind === "feed" && p.message === perm.text).length === 1);

  // 5c. conexion vencida: la cuenta se marca y se bloquea el flujo
  fake.setScenario({ publishFail: { "P-2": "auth" } });
  const auth = await due({ brand: BRAND_SMA, targets: ["acc-fb-smartec"] });
  check("con el token vencido la publicación falla", await waitPost(auth.id, ["FAILED"]));
  const authT = (await targetsOf(auth.id))[0];
  check("el mensaje pide reconectar Meta y no se reintenta", /Reconecta Meta/.test(authT.error ?? "") && authT.retryIn === null);
  const acc = (await db.sql("SELECT status, lastError FROM SocialAccount WHERE id='acc-fb-smartec'"))[0];
  check("la cuenta queda marcada como vencida", acc.status === "EXPIRED" && /Reconecta Meta/.test(acc.lastError ?? ""));
  const blocked = await makePost({ brand: BRAND_SMA, status: "IN_REVIEW", targets: ["acc-fb-smartec"] });
  await aura.goto(`${APP}/publicaciones/${blocked.id}`);
  await aura.getByRole("button", { name: "Aprobar", exact: true }).click();
  await aura.getByText(/venció: vuelve a conectar Meta/).waitFor();
  check("no se puede aprobar algo cuyo destino tiene la conexión vencida", (await postRow(blocked.id)).status === "IN_REVIEW");
  calm();

  // 5d. error temporal de Meta: reintentos con espera creciente
  fake.setScenario({ flaky: { "P-1": 2 } });
  const flaky = await due({});
  check("ante un error temporal queda pendiente, con un reintento en ~2 min", await waitTarget(flaky.id, "acc-fb-reservi", (t) => t.status === "PENDING" && t.attempts === 1));
  const f1 = (await targetsOf(flaky.id))[0];
  check("la espera del primer reintento es de ~2 minutos y se explica", f1.retryIn > 90 && f1.retryIn <= 120 && /problema temporal/.test(f1.error ?? ""), String(f1.retryIn));
  check("mientras espera, la publicación sigue programada (no fallida)", await waitPost(flaky.id, ["SCHEDULED"], 10_000));
  const flakyBefore = feedPosts();
  await sleep(3000);
  check("no se reintenta antes de tiempo", feedPosts() === flakyBefore);
  await dueNow(flaky.id);
  check("pasado el tiempo, lo reintenta (segundo intento)", await waitTarget(flaky.id, "acc-fb-reservi", (t) => t.attempts === 2));
  const f2 = (await targetsOf(flaky.id))[0];
  check("la espera crece a ~10 minutos", f2.status === "PENDING" && f2.retryIn > 540 && f2.retryIn <= 600, String(f2.retryIn));
  await dueNow(flaky.id);
  check("al tercer intento, Meta responde y se publica", await waitPost(flaky.id, ["PUBLISHED"]));
  const f3 = (await targetsOf(flaky.id))[0];
  check("quedan registrados los 3 intentos y se limpia el error", f3.attempts === 3 && f3.error === null && f3.retryIn === null && f3.status === "PUBLISHED");
  check("solo salió una publicación", fake.published().filter((p) => p.kind === "feed" && p.message === flaky.text).length === 1);

  // 5e. limite de uso de Meta: se agotan los intentos
  fake.setScenario({ publishFail: { "P-1": "rate" } });
  const rate = await due({});
  const waits = [120, 600, 1800];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitTarget(rate.id, "acc-fb-reservi", (t) => t.attempts === attempt);
    const t = (await targetsOf(rate.id))[0];
    check(`intento ${attempt}: queda pendiente con espera de ~${waits[attempt - 1] / 60} min`, t.status === "PENDING" && t.retryIn > waits[attempt - 1] - 40 && t.retryIn <= waits[attempt - 1], String(t.retryIn));
    await dueNow(rate.id);
  }
  check("tras 4 intentos fallidos se rinde", await waitPost(rate.id, ["FAILED"]));
  const rateT = (await targetsOf(rate.id))[0];
  check("queda fallida con el motivo y sin más reintentos", rateT.status === "FAILED" && rateT.attempts === 4 && /exceso de consultas/.test(rateT.error ?? "") && rateT.retryIn === null);
  calm();

  // 5f. publicacion parcial: Facebook sale, Instagram no; reintentar solo repite lo que fallo
  fake.setScenario({ publishFail: { "IG-1": "perm" } });
  const part = await due({ targets: ["acc-fb-reservi", "acc-ig-reservi"], image: "jpg" });
  check("si un destino falla y otro sale, queda «Publicada en parte»", await waitPost(part.id, ["PARTIAL"]));
  const pt = await targetsOf(part.id);
  check("Facebook publicado e Instagram fallido, cada uno con lo suyo", pt.find((t) => t.accountId === "acc-fb-reservi")?.status === "PUBLISHED" && pt.find((t) => t.accountId === "acc-ig-reservi")?.status === "FAILED" && /instagram_content_publish/.test(pt.find((t) => t.accountId === "acc-ig-reservi")?.error ?? ""));
  calm();
  await aura.goto(`${APP}/publicaciones/${part.id}`);
  check("la ficha dice «Publicada en parte»", await aura.getByText("Publicada en parte", { exact: true }).first().isVisible());
  await aura.getByRole("button", { name: "Reintentar los que fallaron" }).click();
  check("reintentar completa el destino que faltaba", await waitPost(part.id, ["PUBLISHED"]));
  const afterRetry = fake.published().filter((p) => p.caption === part.text || p.message === part.text);
  check("Facebook NO se vuelve a publicar (una sola foto en total)", afterRetry.filter((p) => p.kind === "photo").length === 1 && afterRetry.filter((p) => p.kind === "ig-container").length === 1);

  // 5g/h. Instagram: el contenedor falla / tarda en procesarse
  fake.setScenario({ igContainer: "error" });
  const igErr = await due({ targets: ["acc-ig-reservi"], image: "jpg" });
  check("si Instagram rechaza la imagen, falla sin reintentar", await waitPost(igErr.id, ["FAILED"]));
  const igErrT = (await targetsOf(igErr.id))[0];
  check("el motivo cita lo que dijo Instagram", /Instagram rechazó la imagen/.test(igErrT.error ?? "") && igErrT.attempts === 1 && igErrT.retryIn === null);
  fake.setScenario({ igContainer: "ok", igProcessing: 1 });
  const igSlow = await due({ targets: ["acc-ig-reservi"], image: "jpg" });
  check("si Instagram tarda en procesar, el worker espera y publica", await waitPost(igSlow.id, ["PUBLISHED"], 45_000));
  calm();

  // 5i. imagen que ya no esta en el servidor
  const gone = await due({ image: "missing" });
  check("si falta el archivo de la imagen, falla con un mensaje claro", (await waitPost(gone.id, ["FAILED"])) && /No se encontró el archivo de la imagen/.test((await targetsOf(gone.id))[0].error ?? ""));

  // 5j. cancelar
  const toCancel = await makePost({ status: "SCHEDULED", scheduled: inMinutes(2 * 24 * 60), image: "jpg" });
  check("programada a futuro, su imagen es pública", (await anon(`${APP}/media/${toCancel.storageKey}`)).status === 200);
  await aura.goto(`${APP}/publicaciones/${toCancel.id}`);
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Cancelar publicación" }).click();
  check("cancelar la deja cancelada y sin fecha", await waitFor(async () => ((await postRow(toCancel.id)).status === "CANCELLED" ? true : null), { timeout: 15_000 }));
  check("cancelada, la imagen deja de ser pública", (await anon(`${APP}/media/${toCancel.storageKey}`)).status === 404);
  await aura.reload();
  check("una cancelada ya no ofrece acciones", (await aura.getByRole("button", { name: "Cancelar publicación" }).count()) === 0 && (await aura.getByRole("button", { name: "Publicar ahora" }).count()) === 0);

  // 5k. el proceso se cayo a media publicacion: no se repite a ciegas
  const beforeStale = fake.requests().length;
  const stale = await makePost({ status: "PUBLISHING", scheduled: inMinutes(-30), targetStatus: "PUBLISHING", locked: inMinutes(-11) });
  check("un destino «publicando» desde hace más de 10 min se da por interrumpido", await waitPost(stale.id, ["FAILED"]));
  const staleT = (await targetsOf(stale.id))[0];
  check("se marca fallido con un aviso para revisar en la red social, sin volver a publicar", staleT.status === "FAILED" && /se interrumpió/.test(staleT.error ?? "") && fake.requests().length === beforeStale);

  // ------------------------------------------------------------ 6. permisos por rol
  const { page: vera } = await newPage();
  await loginAs(vera, USERS.vera);
  const approved = await makePost({ status: "APPROVED" });
  await vera.goto(`${APP}/publicaciones/${approved.id}`);
  check("solo lectura: ve la publicación sin ninguna acción", (await vera.getByText(approved.text).isVisible()) && (await vera.getByRole("button").filter({ hasText: /Programar|Publicar ahora|Cancelar|Aprobar|Reintentar/ }).count()) === 0);
  const veraUp = await vera.context().request.post(`${APP}/api/posts/${mainId}/media`, { multipart: { file: file("x.jpg", "image/jpeg", jpeg(1080, 1080)) }, headers: { origin: APP } });
  check("solo lectura: no puede subir imágenes", veraUp.status() === 401);
  await aura.goto(`${APP}/publicaciones`);
  check("el aprobador no tiene el botón de crear publicaciones", (await aura.getByRole("link", { name: "Nueva publicación" }).count()) === 0);
  await aura.goto(`${APP}/publicaciones/nueva`);
  check("ni puede abrir el editor", aura.url().endsWith("/sin-permiso"));
  await aura.goto(`${APP}/publicaciones/${approved.id}`);
  check("el aprobador sí ve programar, publicar y cancelar una aprobada", (await aura.getByRole("heading", { name: "Programar" }).isVisible()) && (await aura.getByRole("button", { name: "Publicar ahora" }).isVisible()) && (await aura.getByRole("button", { name: "Cancelar publicación" }).isVisible()));
  const sched = await makePost({ status: "SCHEDULED", scheduled: inMinutes(3 * 24 * 60) });
  await edgar.goto(`${APP}/publicaciones/${sched.id}`);
  check("el editor no puede reprogramar ni cancelar lo que ya está programado", (await edgar.getByRole("button", { name: "Reprogramar" }).count()) === 0 && (await edgar.getByRole("button", { name: "Cancelar publicación" }).count()) === 0);
  // En la lista, lo programado se muestra con la hora de la zona de su marca (Smartec está en Nueva York).
  const smaSched = await makePost({ brand: BRAND_SMA, status: "SCHEDULED", targets: ["acc-fb-smartec"], scheduled: inMinutes(3 * 24 * 60 + 7) });
  const smaAt = (await db.sql(`SELECT DATE_FORMAT(scheduledAt, '${ISO}') AS s FROM Post WHERE id=?`, [smaSched.id]))[0].s;
  await aura.goto(`${APP}/publicaciones`);
  const listed = await aura.locator("li", { hasText: smaSched.text }).first().innerText();
  const inNy = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short", timeZone: TZ_SMA }).format(new Date(smaAt));
  check("la lista muestra lo programado en la zona de su marca (Nueva York), no en la del servidor", listed.includes(`Programada ${inNy}`), `${inNy} | ${listed.replace(/\s+/g, " ").slice(0, 120)}`);
  const calUrl = `${APP}/publicaciones/calendario`;
  const calAnon = await anon(calUrl);
  check("el calendario exige sesión", calAnon.status >= 300 && calAnon.status < 400 && (calAnon.headers.get("location") ?? "").includes("/login"));

  // Conexión de Meta sin el permiso de publicar (lo que pasa si la app de Meta no tiene los casos de uso de Páginas/Instagram).
  const NO_PUBLISH = "pages_show_list,ads_read,business_management,pages_read_engagement,public_profile";
  await db.sql("UPDATE SocialAccount SET scopes=? WHERE id='acc-fb-reservi'", [NO_PUBLISH]);
  const noScope = await makePost({ status: "IN_REVIEW" });
  await aura.goto(`${APP}/publicaciones/${noScope.id}`);
  await aura.getByRole("button", { name: "Aprobar", exact: true }).click();
  await aura.getByText(/no incluye el permiso pages_manage_posts/).waitFor();
  check("sin el permiso de publicar, aprobar se rechaza ya, diciendo cuál falta y cómo arreglarlo", (await postRow(noScope.id)).status === "IN_REVIEW" && (await aura.getByText(/Reconectar Meta/).first().isVisible()));
  await admin.goto(`${APP}/cuentas`);
  check("la pantalla Cuentas avisa de la página sin permiso para publicar", await admin.getByText(/Sin permiso para publicar \(falta pages_manage_posts\)/).first().isVisible());
  check("y enlaza al manual para arreglarlo", (await admin.getByRole("link", { name: "Ver cómo" }).first().getAttribute("href")) === "/manual#permisos");
  await admin.goto(`${APP}/manual`);
  check("el manual (Tu estado ahora) nombra la cuenta sin permiso y lleva al paso que lo arregla", (await admin.getByText(/1 cuenta\(s\) conectada\(s\) sin permiso para publicar/).isVisible()) && (await admin.getByText(/Mi Marca\. Sin ese permiso la app no deja aprobar ni publicar/).isVisible()));
  const postsBeforeScope = fake.requests().filter((r) => r.method === "POST").length;
  const stuck = await due({});
  check("si aun así llega a su hora, el worker falla sin llamar a Meta y con el mismo aviso", (await waitPost(stuck.id, ["FAILED"])) && /no incluye el permiso pages_manage_posts/.test((await targetsOf(stuck.id))[0].error ?? "") && fake.requests().filter((r) => r.method === "POST").length === postsBeforeScope);
  check("ese fallo no se reintenta solo ni marca la cuenta como vencida", (await targetsOf(stuck.id))[0].retryIn === null && (await db.sql("SELECT status FROM SocialAccount WHERE id='acc-fb-reservi'"))[0].status === "ACTIVE");
  await db.sql("UPDATE SocialAccount SET scopes=? WHERE id='acc-fb-reservi'", [`${NO_PUBLISH},pages_manage_posts`]);
  await aura.reload();
  await aura.getByRole("button", { name: "Aprobar", exact: true }).click();
  check("al reconectar con el permiso concedido, ya se puede aprobar", await waitPost(noScope.id, ["APPROVED"], 15_000));
  await db.sql("UPDATE SocialAccount SET scopes=NULL WHERE id='acc-fb-reservi'");

  // ------------------------------------------------------------ 7. calendario
  // Los datos del calendario van en el MES SIGUIENTE: asi no se mezclan con las publicaciones que esta misma
  // prueba crea hoy y mañana (una celda muestra como maximo 3 y esconderia las demas tras «+N más»).
  const [ty, tm] = localParts(new Date(), TZ_RES).day.split("-").map(Number);
  const monthKey = (offset) => new Date(Date.UTC(ty, tm - 1 + offset, 1, 12)).toISOString().slice(0, 7);
  const thisMonth = monthKey(0);
  const nextMonth = monthKey(1);
  const afterMonth = monthKey(2);
  const edge = new Date(Date.UTC(ty, tm + 1, 1, 3, 0, 0)); // 1.° del mes que sigue al siguiente, 03:00 UTC: sigue siendo el mes siguiente en Bogotá y Nueva York
  const pubDay = new Date(Date.UTC(ty, tm, 10, 15, 0, 0)); // el 10 del mes siguiente
  const pubPlanned = new Date(Date.UTC(ty, tm, 9, 15, 0, 0)); // estaba programada un día antes
  const calSched = await makePost({ status: "SCHEDULED", scheduled: atUtc(edge) });
  const calPub = await makePost({ brand: BRAND_SMA, status: "PUBLISHED", targets: ["acc-fb-smartec"], targetStatus: "PUBLISHED", scheduled: atUtc(pubPlanned), published: atUtc(pubDay) });
  const calApproved = await makePost({ status: "APPROVED", text: `Aprobada sin fecha ${tag()}` });
  const calDraft = await makePost({ status: "DRAFT", text: `Borrador sin fecha ${tag()}` });
  const expSched = localParts(edge, TZ_RES);
  const expPub = localParts(pubDay, TZ_SMA);
  const monthName = (key) => new Intl.DateTimeFormat("es", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}-01T12:00:00Z`));
  const monthTitle = (key) => monthName(key).charAt(0).toUpperCase() + monthName(key).slice(1); // «Noviembre de 2026»
  const heading = (page, key) => page.getByText(monthTitle(key), { exact: true });

  const chip = (page, id) => page.locator(`a[href="/publicaciones/${id}"]:visible`);
  const dayOf = async (page, id) => (await chip(page, id).first().locator("xpath=ancestor::div[contains(@class,'min-h-28')][1]/p[1]").innerText()).trim();

  await aura.goto(calUrl);
  check("el calendario abre en el mes actual", (await heading(aura, thisMonth).count()) === 1);
  await aura.getByRole("link", { name: "Mes siguiente" }).click();
  await aura.waitForURL(new RegExp(`mes=${nextMonth}`));
  check("«Mes siguiente» avanza un mes", (await heading(aura, nextMonth).count()) === 1);
  check("lo programado cerca de medianoche UTC cae en el día de la zona de su marca (último día del mes, 22:00 en Bogotá)", expSched.day.startsWith(nextMonth) && (await chip(aura, calSched.id).count()) === 1 && (await dayOf(aura, calSched.id)) === String(Number(expSched.day.slice(8))), `${expSched.day} ${expSched.time}`);
  check("la hora del chip es la de la marca", (await chip(aura, calSched.id).innerText()).includes(expSched.time));
  check("lo ya publicado va en el día en que salió (no en el programado), con la hora de su marca", (await chip(aura, calPub.id).count()) === 1 && (await dayOf(aura, calPub.id)) === "10" && (await chip(aura, calPub.id).innerText()).includes(expPub.time), `${expPub.day} ${expPub.time}`);
  const asideText = await aura.locator("main aside").innerText();
  check("«Aprobadas sin fecha» lista las aprobadas, no los borradores", asideText.includes(calApproved.text) && !asideText.includes(calDraft.text));
  check("una aprobada sin fecha solo está en ese panel, no en la cuadrícula ni en la agenda", (await aura.locator(`a[href="/publicaciones/${calApproved.id}"]`).count()) === 1);
  check("el borrador sin fecha no aparece en ningún sitio", (await aura.locator(`a[href="/publicaciones/${calDraft.id}"]`).count()) === 0);
  await shot(aura, "calendario-claro.png");

  await aura.getByRole("link", { name: "Mes siguiente" }).click();
  await aura.waitForURL(new RegExp(`mes=${afterMonth}`));
  check("el mes que sigue no repite lo que cae en el anterior (por zona horaria)", (await chip(aura, calSched.id).count()) === 0 && (await chip(aura, calPub.id).count()) === 0);
  await aura.getByRole("link", { name: "Mes anterior" }).click();
  await aura.waitForURL(new RegExp(`mes=${nextMonth}`));
  await aura.getByRole("navigation", { name: "Marca" }).getByRole("link", { name: "Smartec" }).click();
  await aura.waitForURL(/marca=brand-smartec/);
  check("el filtro por marca muestra solo esa marca (también en el panel de aprobadas)", (await chip(aura, calPub.id).count()) === 1 && (await chip(aura, calSched.id).count()) === 0 && !(await aura.locator("main").innerText()).includes(calApproved.text));
  check("el filtro y el mes se conservan al cambiar de mes", (await aura.getByRole("link", { name: "Mes siguiente" }).getAttribute("href")).includes("marca=brand-smartec") && (await aura.getByRole("link", { name: "Mes siguiente" }).getAttribute("href")).includes(`mes=${afterMonth}`));
  await aura.goto(`${calUrl}?mes=2026-13&marca=inventada`);
  check("un mes o una marca inválidos no rompen la página: se ignoran", (await heading(aura, thisMonth).count()) === 1 && (await aura.getByText(/Algo salió mal|Application error/).count()) === 0);
  await aura.getByRole("link", { name: "Lista", exact: true }).click();
  await aura.waitForURL(`${APP}/publicaciones`);
  check("se puede pasar del calendario a la lista y volver", (await aura.getByRole("link", { name: "Calendario", exact: true }).count()) === 1);

  const { page: mob } = await newPage({ width: 390, height: 844 }, { deviceScaleFactor: 2 });
  await loginAs(mob, USERS.aura);
  await mob.goto(`${calUrl}?mes=${nextMonth}`);
  check("en el móvil se muestra una agenda (no la cuadrícula) y no hay scroll horizontal", (await chip(mob, calSched.id).count()) === 1 && (await chip(mob, calPub.id).count()) === 1 && (await mob.getByText("Lun", { exact: true }).isVisible()) === false && (await mob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)));
  await shot(mob, "calendario-movil.png");
  const { page: dark } = await newPage({ width: 1280, height: 1000 }, { colorScheme: "dark" });
  await loginAs(dark, USERS.aura);
  await dark.goto(`${calUrl}?mes=${nextMonth}`);
  await shot(dark, "calendario-oscuro.png");

  // ------------------------------------------------------------ 8. secretos y auditoria
  const secrets = (await db.sql("SELECT accessTokenEnc FROM SocialAccount")).map((r) => r.accessTokenEnc).concat([PAGE_TOKEN, "PAGE-TOKEN-2222", APP_SECRET, "accessTokenEnc"]);
  const html = [];
  for (const u of ["/publicaciones", `/publicaciones/${mainId}`, `/publicaciones/${perm.id}`, "/publicaciones/calendario", "/cuentas"]) html.push(await (await adminCtx.request.get(`${APP}${u}`)).text());
  check("ninguna pantalla contiene tokens, secretos ni su versión cifrada", !secrets.some((s) => html.join("\n").includes(s)));
  const actions = new Set((await db.sql("SELECT action FROM AuditLog")).map((a) => a.action));
  check("la auditoría registra todo el recorrido", ["post.submitted", "post.returned", "post.approved", "post.scheduled", "post.publish_now", "post.retry", "post.cancelled", "post.media_added", "post.media_removed", "post.target_published", "post.target_failed", "post.published", "post.partial", "post.failed"].every((k) => actions.has(k)), [...actions].join(","));
  check("la auditoría no contiene tokens", !JSON.stringify(await db.sql("SELECT detail FROM AuditLog")).includes(PAGE_TOKEN));
  check("el worker no registró errores internos en toda la prueba", !logs.some((l) => /error interno|fallo la vuelta|fallo una vuelta/.test(l)), logs.filter((l) => /error interno|fallo la vuelta|fallo una vuelta/.test(l)).slice(0, 3).join(" | "));

  // ------------------------------------------------------------ 9. Instagram sin direccion publica (solo B, ya sin worker en A)
  appA.kill();
  await sleep(1500);
  const igLocal = await makePost({ status: "APPROVED", targets: ["acc-ig-reservi"], image: "jpg" });
  await aura.goto(`${PLAIN}/publicaciones/${igLocal.id}`);
  const beforeLocal = fake.requests().length;
  aura.once("dialog", (d) => d.accept());
  await aura.getByRole("button", { name: "Publicar ahora" }).click();
  check("con la app en una dirección local, Instagram falla antes de llamar a Meta", await waitPost(igLocal.id, ["FAILED"]));
  const igLocalT = (await targetsOf(igLocal.id))[0];
  check("el mensaje explica que hace falta una dirección pública con HTTPS, sin reintentos", /no es accesible desde fuera/.test(igLocalT.error ?? "") && /HTTPS/.test(igLocalT.error ?? "") && igLocalT.retryIn === null && fake.requests().length === beforeLocal);
  void edgarCtx;
  void auraCtx;
} catch (e) {
  fail("excepción en el recorrido", String(e?.stack ?? e).slice(0, 900));
  console.log("\n--- ultimas lineas de la app ---");
  console.log(logs.slice(-30).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [appA, appB]) child?.kill();
  await fake?.close().catch(() => {});
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
}

process.exit(finish());
