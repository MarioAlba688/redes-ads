// Prueba de extremo a extremo de la Fase 3a: marcas, generador con IA y borradores, con un Claude SIMULADO
// (fake-anthropic.mjs): no gasta dinero ni necesita clave. Arranca por si misma la app (hace falta
// `npm run build`) y el servidor falso. VACIA la base de pruebas (solo corre contra una base *_test).

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";
import { createChecker, createDb, findChrome, requireTestDb, startApp, waitFor, waitReady } from "./helpers.mjs";
import { FAKE_API_KEY, startFakeAnthropic } from "./fake-anthropic.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_PORT = Number(process.env.E2E_CONTENT_PORT ?? 3300);
const PLAIN_PORT = APP_PORT + 1; // segunda instancia SIN clave de la IA
const FAKE_PORT = Number(process.env.E2E_FAKE_AI_PORT ?? 4020);
const APP = `http://localhost:${APP_PORT}`;
const PLAIN = `http://localhost:${PLAIN_PORT}`;
const SETUP_TOKEN = "codigo-de-prueba-123";
const SHOTS = process.env.E2E_SHOTS_DIR;
const LIMIT = 10;

const ADMIN = { name: "Mario Alba", email: "mario@example.com", pass: "clave-admin-2026" };
const USERS = {
  edgar: { id: "u-edgar-0001", name: "Edgar Editor", email: "edgar@example.com", pass: "clave-edgar-2026x", role: "EDITOR" },
  edwin: { id: "u-edwin-0001", name: "Edwin Editor", email: "edwin@example.com", pass: "clave-edwin-2026x", role: "EDITOR" },
  aura: { id: "u-aura-00001", name: "Aura Aprobadora", email: "aura@example.com", pass: "clave-aura-2026xx", role: "APPROVER" },
  vera: { id: "u-vera-00001", name: "Vera Lectora", email: "vera@example.com", pass: "clave-vera-2026xx", role: "VIEWER" },
};

const { raw: DB_URL, url: dbUrl } = requireTestDb();
const db = createDb(dbUrl);
const { check, fail, finish } = createChecker();

if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("Falta compilar la app: ejecuta `npm run build` antes de esta prueba.");
  process.exit(2);
}

const logs = [];
const num = (v) => Number(v);
let fake;
let appA;
let appB;
let browser;
try {
  await db.reset();
  fake = await startFakeAnthropic(FAKE_PORT);

  const baseEnv = {
    DATABASE_URL: DB_URL,
    SETUP_TOKEN,
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    E2E_DATABASE_URL: "",
    META_APP_ID: "",
    META_APP_SECRET: "",
    META_SCOPES: "",
    META_LOGIN_CONFIG_ID: "",
    AI_MODEL: "",
    AI_EFFORT: "",
  };
  appA = startApp({
    root: ROOT,
    port: APP_PORT,
    logs,
    env: { ...baseEnv, APP_URL: APP, ANTHROPIC_API_KEY: FAKE_API_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`, AI_DAILY_LIMIT: String(LIMIT) },
  });
  appB = startApp({ root: ROOT, port: PLAIN_PORT, logs, env: { ...baseEnv, APP_URL: PLAIN, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "" } });
  await Promise.all([waitReady(APP), waitReady(PLAIN)]);

  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const newPage = async (viewport = { width: 1280, height: 1000 }) => {
    const ctx = await browser.newContext({ viewport });
    return { ctx, page: await ctx.newPage() };
  };
  const loginAs = async (page, u) => {
    await page.goto(`${APP}/login`);
    await page.getByLabel("Correo").fill(u.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(u.pass);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL(`${APP}/`);
  };

  // ------------------------------------------------------------ 0. instalacion, usuarios y cuentas
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
  const account = (id, kind, ext, name, handle = null) =>
    db.sql(
      "INSERT INTO SocialAccount (id, platform, kind, externalId, name, handle, status, accessTokenEnc, createdAt, updatedAt) VALUES (?, 'META', ?, ?, ?, ?, 'ACTIVE', 'v1.a.b.c', NOW(3), NOW(3))",
      [id, kind, ext, name, handle],
    );
  await account("acc-fb-reservi", "FACEBOOK_PAGE", "P-RES", "Reservi");
  await account("acc-ig-reservi", "INSTAGRAM_PROFILE", "IG-RES", "Reservi Oficial", "@reservi.app");
  await account("acc-fb-smartec", "FACEBOOK_PAGE", "P-SMA", "Smartec");
  await account("acc-ad-1", "AD_ACCOUNT", "9001", "Cuenta publicitaria");

  // ------------------------------------------------------------ 1. marcas
  check("el menú tiene Marcas y Publicaciones", (await admin.getByRole("link", { name: "Marcas" }).count()) === 1 && (await admin.getByRole("link", { name: "Publicaciones" }).count()) === 1);
  await admin.goto(`${APP}/marcas`);
  check("sin marcas, se explica qué hacer", await admin.getByText("Aún no hay marcas").isVisible());
  await admin.goto(`${APP}/marcas/nueva`);
  await admin.getByLabel("Nombre de la marca").fill("Reservi");
  await admin.getByLabel("¿Qué hace el negocio?").fill("corta");
  await admin.getByRole("button", { name: "Crear marca" }).click();
  await admin.getByText(/al menos 20 caracteres/).waitFor();
  check("la descripción corta se rechaza con un mensaje claro", true);
  check("tras el error se conserva el nombre", (await admin.getByLabel("Nombre de la marca").inputValue()) === "Reservi");

  await admin.getByLabel("¿Qué hace el negocio?").fill("Sistema de reservas en línea para restaurantes y salones de belleza en Colombia.");
  await admin.getByLabel("¿A quién le habla?").fill("Dueños de pequeños negocios");
  await admin.getByLabel("Tono y voz").fill("Cercano y directo, sin tecnicismos");
  await admin.getByLabel("Palabras o temas que nunca deben aparecer").fill("gratis\nbarato");
  await admin.getByLabel("Hashtags de la marca").fill("#reservi #reservas");
  await admin.locator('input[name="accountId"][value="acc-fb-reservi"]').check();
  await admin.locator('input[name="accountId"][value="acc-ig-reservi"]').check();
  await admin.getByRole("button", { name: "Crear marca" }).click();
  await admin.waitForURL(/\/marcas\/[^/]+\?creada=1/);
  check("crear una marca lleva a su ficha con aviso", await admin.getByText("Marca creada.").isVisible());
  const reserviId = admin.url().match(/\/marcas\/([^/?]+)/)[1];
  const brand = (await db.sql("SELECT * FROM Brand WHERE id=?", [reserviId]))[0];
  check("la marca se guardó con su perfil", brand?.name === "Reservi" && brand.avoid === "gratis\nbarato" && brand.language === "es" && brand.timezone === "America/Bogota" && brand.audience === "Dueños de pequeños negocios");
  const owned = await db.sql("SELECT id FROM SocialAccount WHERE brandId=? ORDER BY id", [reserviId]);
  check("las cuentas marcadas pasan a ser de la marca", owned.map((r) => r.id).join() === "acc-fb-reservi,acc-ig-reservi");

  await admin.goto(`${APP}/marcas/nueva`);
  await admin.getByLabel("Nombre de la marca").fill("Smartec");
  await admin.getByLabel("¿Qué hace el negocio?").fill("Tecnología y accesorios para el hogar y la oficina, con envíos a todo el país.");
  check("una cuenta de otra marca aparece bloqueada", await admin.locator('input[name="accountId"][value="acc-fb-reservi"]').isDisabled());
  await admin.locator('input[name="accountId"][value="acc-fb-smartec"]').check();
  await admin.getByRole("button", { name: "Crear marca" }).click();
  await admin.waitForURL(/\/marcas\/[^/]+\?creada=1/);
  const smartecId = admin.url().match(/\/marcas\/([^/?]+)/)[1];

  await admin.goto(`${APP}/marcas/${reserviId}`);
  await admin.getByLabel("Tono y voz").fill("Muy cercano, con humor suave");
  await admin.getByRole("button", { name: "Guardar cambios" }).click();
  await admin.getByText("Marca guardada.").waitFor();
  check("editar la marca guarda los cambios", (await db.sql("SELECT tone FROM Brand WHERE id=?", [reserviId]))[0].tone === "Muy cercano, con humor suave");
  check("tras guardar, el formulario muestra lo recién guardado (y el aviso sigue visible)", (await admin.getByLabel("Tono y voz").inputValue()) === "Muy cercano, con humor suave" && (await admin.getByText("Marca guardada.").isVisible()));
  await admin.reload();
  check("al recargar, el cambio persiste", (await admin.getByLabel("Tono y voz").inputValue()) === "Muy cercano, con humor suave");

  await admin.goto(`${APP}/marcas/nueva`);
  await admin.getByLabel("Nombre de la marca").fill("Temporal");
  await admin.getByLabel("¿Qué hace el negocio?").fill("Una marca de prueba que se va a borrar enseguida de esta prueba.");
  await admin.getByRole("button", { name: "Crear marca" }).click();
  await admin.waitForURL(/\/marcas\/[^/]+\?creada=1/);
  admin.once("dialog", (d) => d.accept());
  await admin.getByRole("button", { name: "Eliminar marca" }).click();
  await admin.waitForURL(`${APP}/marcas`);
  check("se puede eliminar una marca sin publicaciones", Number((await db.sql("SELECT COUNT(*) c FROM Brand WHERE name='Temporal'"))[0].c) === 0);

  // ------------------------------------------------------------ 2. editor (Edgar): generar con IA
  const { page: edgar } = await newPage();
  await loginAs(edgar, USERS.edgar);
  await edgar.goto(`${APP}/publicaciones/nueva`);
  check("sin elegir marca, se muestran las marcas para escoger", (await edgar.getByRole("heading", { name: "Reservi" }).isVisible()) && (await edgar.getByRole("heading", { name: "Smartec" }).isVisible()));
  await edgar.getByRole("heading", { name: "Reservi" }).click();
  await edgar.waitForURL(/marca=/);
  check("el editor muestra los destinos de la marca (Facebook e Instagram)", (await edgar.locator('input[name="targetId"]').count()) === 2);
  check("los destinos de otra marca no aparecen", (await edgar.getByText("Smartec").count()) === 0);
  check("muestra el consumo de la IA", await edgar.getByText(`Llevas 0 de ${LIMIT} generaciones`).isVisible());

  const brief = edgar.getByLabel("¿De qué quieres publicar?");
  await brief.fill("corto");
  await edgar.getByRole("button", { name: "Generar opciones" }).click();
  await edgar.getByText(/al menos 10 caracteres/).waitFor();
  check("una petición demasiado corta se rechaza sin llamar a la IA", fake.requests().length === 0);

  await brief.fill("Lanzamos el plan Pro con reservas ilimitadas ENLACE LARGO");
  await edgar.getByLabel("Opciones").selectOption("3");
  await edgar.getByRole("button", { name: "Generar opciones" }).click();
  await edgar.getByRole("button", { name: "Usar este texto" }).first().waitFor({ timeout: 30_000 });
  check("aparecen las 3 opciones", (await edgar.getByRole("button", { name: "Usar este texto" }).count()) === 3);

  const req = fake.requests().at(-1);
  check("la petición a Claude lleva la clave y el modelo configurados", req?.apiKey === FAKE_API_KEY && req.body.model === "claude-opus-5-5");
  check("pide salida JSON estructurada y esfuerzo medio", req?.body.output_config?.format?.type === "json_schema" && req.body.output_config.effort === "medium");
  check("activa el respaldo ante rechazos del servidor", req?.body.fallbacks === "default" && String(req.beta).includes("server-side-fallback-2026-07-01"));
  check("el perfil de marca viaja en el sistema, con las palabras vetadas y cache", req?.body.system?.[0]?.text.includes("«Reservi»") && req.body.system[0].text.includes("gratis, barato") && req.body.system[0].text.includes("Cercano") === false /* se editó el tono */ && req.body.system[0].text.includes("Muy cercano, con humor suave") && req.body.system[0].cache_control?.type === "ephemeral");
  check("la petición del equipo va en el mensaje del usuario", String(req?.body.messages?.[0]?.content).includes("plan Pro con reservas ilimitadas"));
  check("no manda parámetros que el modelo rechaza", !["thinking", "temperature", "top_p", "top_k", "tool_choice"].some((k) => k in (req?.body ?? {})));
  const platformSection = String(req?.body.system?.[0]?.text).split("# Plataforma")[1]?.slice(0, 90).replace(/\n/g, " ");
  check("para destinos de Facebook e Instagram pide texto para ambos", String(req?.body.system?.[0]?.text).includes("Facebook e Instagram a la vez"), platformSection);

  const cardsText = await edgar.locator("main aside").innerText();
  check("avisa del enlace (Instagram) y del límite de caracteres", /enlace; en Instagram no se puede pulsar/.test(cardsText) && /límite es 2200/.test(cardsText));
  check("los hashtags se limpian y sin repetidos", /#reservi #Reservas #agenda/.test(cardsText) && !/#reservi #Reservas #agenda #reservi/.test(cardsText));

  // la opcion larga (3a) no se puede guardar hasta acortarla
  await edgar.getByRole("button", { name: "Usar este texto" }).nth(2).click();
  check("al usar un texto demasiado largo se marca en rojo y no deja guardar", (await edgar.getByRole("button", { name: "Guardar borrador" }).isDisabled()) && /23\d\d \/ 2200/.test(await edgar.locator("#text-count").innerText()), (await edgar.locator("#text-count").innerText()).trim());
  await edgar.getByRole("button", { name: "Guardar borrador" }).evaluate((b) => (b.disabled = false));
  await edgar.getByRole("button", { name: "Guardar borrador" }).click();
  await edgar.getByText(/límite es 2200 \(Instagram\)/).waitFor();
  check("aunque se fuerce el botón, el servidor rechaza el texto largo", Number((await db.sql("SELECT COUNT(*) c FROM Post"))[0].c) === 0);

  // usar la opcion 2 y guardar
  await edgar.getByRole("button", { name: "Usar este texto" }).nth(1).click();
  const chosen = await edgar.locator("#text").inputValue();
  check("«Usar este texto» pasa la opción al editor", chosen.startsWith("Imagina:") && chosen.includes("#reservi"));
  await edgar.getByLabel("Enlace (opcional)").fill("ftp://no-valido");
  await edgar.getByRole("button", { name: "Guardar borrador" }).click();
  await edgar.getByText(/debe empezar con http/).waitFor();
  check("un enlace que no es http(s) se rechaza", true);
  check("el texto sigue ahí tras el error", (await edgar.locator("#text").inputValue()) === chosen);
  await edgar.getByLabel("Enlace (opcional)").fill("https://reservi.example/planes");
  await edgar.getByRole("button", { name: "Guardar borrador" }).click();
  await edgar.waitForURL(/\/publicaciones\/[^/]+\?guardada=1/);
  check("guardar lleva al borrador con aviso", await edgar.getByText("Borrador guardado.").first().isVisible());
  const postId = edgar.url().match(/publicaciones\/([^/?]+)/)[1];
  const post = (await db.sql("SELECT * FROM Post WHERE id=?", [postId]))[0];
  check("el borrador se guardó con marca, texto, enlace y autor", post.status === "DRAFT" && post.brandId === reserviId && post.text === chosen && post.linkUrl === "https://reservi.example/planes" && post.createdById === USERS.edgar.id);
  check("queda marcado como generado con IA y guarda la petición", post.aiGenerated == 1 && String(post.aiBrief).includes("plan Pro"));
  const targets = await db.sql("SELECT accountId, status FROM PostTarget WHERE postId=? ORDER BY accountId", [postId]);
  check("se crearon los 2 destinos pendientes", targets.map((t) => `${t.accountId}:${t.status}`).join() === "acc-fb-reservi:PENDING,acc-ig-reservi:PENDING");

  // ------------------------------------------------------------ 3. editar el borrador
  await edgar.getByLabel("Texto de la publicación").fill("Texto editado por una persona, más corto y directo. #reservi");
  await edgar.locator('input[name="targetId"][value="acc-ig-reservi"]').uncheck();
  await edgar.getByRole("button", { name: "Guardar cambios" }).click();
  // El aviso "Borrador guardado." de la URL (?guardada=1) ya estaba en pantalla: se espera al cambio real en la base.
  await waitFor(async () => (await db.sql("SELECT text FROM Post WHERE id=?", [postId]))[0].text.startsWith("Texto editado"), { timeout: 15_000 });
  await edgar.getByText("Borrador guardado.").nth(1).waitFor({ timeout: 10_000 });
  const edited = (await db.sql("SELECT text, aiGenerated FROM Post WHERE id=?", [postId]))[0];
  const targets2 = await db.sql("SELECT accountId FROM PostTarget WHERE postId=?", [postId]);
  check("editar actualiza el texto y mantiene la marca de IA", edited.text.startsWith("Texto editado") && edited.aiGenerated == 1);
  check("quitar un destino lo borra y deja solo Facebook", targets2.length === 1 && targets2[0].accountId === "acc-fb-reservi");
  await edgar.goto(`${APP}/publicaciones`);
  check("la lista muestra el borrador con su marca, destino y la etiqueta IA", (await edgar.getByText("Texto editado por una persona").isVisible()) && (await edgar.getByText("Borrador").first().isVisible()) && (await edgar.getByText("IA", { exact: true }).first().isVisible()));
  await edgar.getByRole("link", { name: /Borradores/ }).click();
  await edgar.waitForURL(/estado=borradores/);
  check("el filtro «Borradores» funciona", await edgar.getByText("Texto editado por una persona").isVisible());
  await edgar.getByRole("link", { name: /Publicadas/ }).click();
  await edgar.waitForURL(/estado=publicadas/);
  check("el filtro «Publicadas» no muestra borradores", await edgar.getByText("No hay publicaciones en este estado").isVisible());

  // ------------------------------------------------------------ 4. palabras vetadas y errores de la IA
  const gen = async (page, text, { count = "2", wait } = {}) => {
    await page.goto(`${APP}/publicaciones/nueva?marca=${reserviId}`);
    await page.getByLabel("¿De qué quieres publicar?").fill(text);
    await page.getByLabel("Opciones").selectOption(count);
    await page.getByRole("button", { name: "Generar opciones" }).click();
    try {
      await page.getByText(wait).first().waitFor({ timeout: 30_000 });
    } catch (e) {
      // Ayuda a diagnosticar: que se veia en pantalla cuando no aparecio lo esperado.
      const panel = await page.locator("main aside").innerText().catch(() => "(sin panel de IA)");
      console.log(`\n[gen] no aparecio ${wait} para «${text}». Panel de IA:\n${panel.slice(0, 1500)}\n`);
      throw e;
    }
  };

  await gen(edgar, "Promoción de lanzamiento VETADA", { wait: /Se descartaron 1 opción/ });
  check("una opción con palabra vetada se descarta y se avisa", (await edgar.getByRole("button", { name: "Usar este texto" }).count()) === 1 && !(await edgar.locator("main aside").innerText()).includes("GRATIS hoy"));
  await gen(edgar, "Todo TODOVETADO aquí", { wait: /Ninguna opción cumplió las reglas de la marca/ });
  check("si todas incumplen, se explica y se pide cambiar la petición", true);
  await gen(edgar, "Algo con ERROR401 para probar", { wait: /clave de Claude \(Anthropic\) no es válida/ });
  check("clave inválida: mensaje claro sin mostrar la clave", !(await edgar.locator("body").innerText()).includes(FAKE_API_KEY));
  const before429 = fake.requests().length;
  await gen(edgar, "Algo con LIMITE429 aquí", { wait: /demasiadas peticiones/ });
  check("ante un 429 el SDK reintenta (3 llamadas) y luego avisa", fake.requests().length - before429 === 3, String(fake.requests().length - before429));
  await gen(edgar, "Algo para REHUSAR aquí", { wait: /no quiso redactar esto/ });
  check("un rechazo del modelo (refusal) se explica", true);
  await gen(edgar, "Algo CORTADO por tokens", { wait: /respuesta de la IA se cortó/ });
  check("una respuesta cortada por max_tokens se avisa", true);
  await gen(edgar, "Algo de BASURA no JSON", { wait: /no se pudo leer/ });
  check("una respuesta que no es JSON se avisa", true);
  await gen(edgar, "Algo con SINCREDITO aquí", { wait: /no tiene saldo/ });
  check("sin saldo en Anthropic: el mensaje dice cómo resolverlo", true);
  const beforeFallback = fake.requests().length;
  await gen(edgar, "Algo con SINRESPALDO aquí", { wait: /Usar este texto/ });
  const sent = fake.requests().slice(beforeFallback);
  check("si la API rechaza el respaldo, reintenta sin él y funciona", sent.length === 2 && sent[0].body.fallbacks === "default" && sent[1].body.fallbacks === undefined && !sent[1].beta);

  // ------------------------------------------------------------ 5. limite diario
  const used = Number((await db.sql("SELECT COUNT(*) c FROM AiGeneration WHERE userId=?", [USERS.edgar.id]))[0].c);
  check(`cada intento queda registrado (también los fallidos): ${LIMIT} generaciones`, used === LIMIT, String(used));
  const okRows = Number((await db.sql("SELECT COUNT(*) c FROM AiGeneration WHERE userId=? AND ok=1", [USERS.edgar.id]))[0].c);
  check("se distingue lo que salió bien de lo que falló", okRows === 3, String(okRows)); // normal, GRATIS (1 descartada) y SINRESPALDO
  const tokens = (await db.sql("SELECT SUM(inputTokens) i, SUM(outputTokens) o FROM AiGeneration WHERE userId=? AND ok=1", [USERS.edgar.id]))[0];
  check("se guardan los tokens consumidos", num(tokens.i) > 0 && num(tokens.o) > 0);
  await edgar.goto(`${APP}/publicaciones/nueva?marca=${reserviId}`);
  check("al llegar al límite se muestra y el botón se desactiva", (await edgar.getByText(`Llevas ${LIMIT} de ${LIMIT} generaciones`).isVisible()) && (await edgar.getByRole("button", { name: "Generar opciones" }).isDisabled()));
  const reqsBeforeLimit = fake.requests().length;
  await edgar.getByLabel("¿De qué quieres publicar?").fill("Intento número once forzando el botón");
  await edgar.getByRole("button", { name: "Generar opciones" }).evaluate((b) => (b.disabled = false));
  await edgar.getByRole("button", { name: "Generar opciones" }).click();
  await edgar.getByText(new RegExp(`límite de ${LIMIT} generaciones`)).waitFor();
  check("el límite lo exige el servidor (no solo el botón) y no llama a la IA", fake.requests().length === reqsBeforeLimit);

  const { ctx: edwinCtx, page: edwin } = await newPage();
  await loginAs(edwin, USERS.edwin);
  await gen(edwin, "Otra persona del equipo pide su propio texto", { count: "1", wait: /Usar este texto/ });
  check("el límite es por persona: otro editor sí puede generar", true);

  // ------------------------------------------------------------ 6. permisos por rol
  const { ctx: veraCtx, page: vera } = await newPage();
  await loginAs(vera, USERS.vera);
  await vera.goto(`${APP}/publicaciones`);
  check("solo lectura: ve la lista de publicaciones pero no el botón de crear", (await vera.getByText("Texto editado por una persona").isVisible()) && (await vera.getByRole("link", { name: "Nueva publicación" }).count()) === 0);
  await vera.goto(`${APP}/publicaciones/nueva`);
  check("solo lectura: no puede abrir el editor", vera.url().endsWith("/sin-permiso"));
  await vera.goto(`${APP}/publicaciones/${postId}`);
  check("solo lectura: ve el borrador sin editor ni botón de guardar", (await vera.getByText("Texto editado por una persona").isVisible()) && (await vera.getByRole("button", { name: "Guardar cambios" }).count()) === 0);
  await vera.goto(`${APP}/marcas/${reserviId}`);
  check("solo lectura: ve el perfil de la marca sin formulario", (await vera.getByText("Muy cercano, con humor suave").isVisible()) && (await vera.getByRole("button", { name: "Guardar cambios" }).count()) === 0);
  await vera.goto(`${APP}/marcas/nueva`);
  check("solo lectura: no puede crear marcas", vera.url().endsWith("/sin-permiso"));

  const { ctx: auraCtx, page: aura } = await newPage();
  await loginAs(aura, USERS.aura);
  await aura.goto(`${APP}/publicaciones/nueva`);
  check("el aprobador no crea publicaciones", aura.url().endsWith("/sin-permiso"));
  await aura.goto(`${APP}/marcas/nueva`);
  check("el aprobador no gestiona marcas", aura.url().endsWith("/sin-permiso"));
  await aura.goto(`${APP}/publicaciones`);
  check("el aprobador sí ve las publicaciones", await aura.getByText("Texto editado por una persona").isVisible());

  await edgar.goto(`${APP}/marcas/nueva`);
  check("el editor sí gestiona marcas", await edgar.getByRole("heading", { name: "Nueva marca" }).isVisible());

  // ------------------------------------------------------------ 7. borrar
  await admin.goto(`${APP}/marcas/${reserviId}`);
  admin.once("dialog", (d) => d.accept());
  await admin.getByRole("button", { name: "Eliminar marca" }).click();
  await admin.getByText(/tiene 1 publicación\(es\)/).waitFor();
  check("no se puede eliminar una marca con publicaciones", Number((await db.sql("SELECT COUNT(*) c FROM Brand WHERE id=?", [reserviId]))[0].c) === 1);

  await edgar.goto(`${APP}/publicaciones/${postId}`);
  edgar.once("dialog", (d) => d.accept());
  await edgar.getByRole("button", { name: "Borrar", exact: true }).click();
  await edgar.waitForURL(`${APP}/publicaciones`);
  check("un editor puede borrar un borrador", Number((await db.sql("SELECT COUNT(*) c FROM Post WHERE id=?", [postId]))[0].c) === 0 && Number((await db.sql("SELECT COUNT(*) c FROM PostTarget WHERE postId=?", [postId]))[0].c) === 0);

  // ------------------------------------------------------------ 8. panel y IA sin configurar
  await admin.goto(`${APP}/`);
  const dash = await admin.locator("main").innerText();
  check("el panel marca como hechos los pasos de marca y de publicación", /Definir el perfil de cada marca para la IA/.test(dash));
  await admin.goto(`${PLAIN}/publicaciones/nueva?marca=${reserviId}`);
  check("sin ningún motor configurado, el panel de IA explica qué hacer (y el administrador tiene el enlace)", (await admin.getByText(/La IA todavía no está activada/).first().isVisible()) && (await admin.getByRole("link", { name: "Motores de IA", exact: true }).count()) >= 1);
  check("sin clave no hay botón de generar", (await admin.getByRole("button", { name: "Generar opciones" }).count()) === 0);

  // ------------------------------------------------------------ 9. secretos y auditoria
  const html = [await (await adminCtx.request.get(`${APP}/marcas`)).text(), await (await adminCtx.request.get(`${APP}/publicaciones/nueva?marca=${reserviId}`)).text()].join("\n");
  check("la clave de la IA no aparece en ninguna pantalla", !html.includes(FAKE_API_KEY) && !html.includes("sk-ant"));
  const audit = await db.sql("SELECT action, detail FROM AuditLog");
  const kinds = new Set(audit.map((a) => a.action));
  check("la auditoría registra marcas, borradores y usos de la IA", ["brand.created", "brand.updated", "brand.deleted", "post.created", "post.updated", "post.deleted", "ai.generated"].every((k) => kinds.has(k)), [...kinds].join(","));
  check("la auditoría no contiene la clave", !JSON.stringify(audit).includes(FAKE_API_KEY));

  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await edgar.goto(`${APP}/publicaciones/nueva?marca=${reserviId}`);
    await edgar.getByLabel("¿De qué quieres publicar?").fill("Lanzamos el plan Pro con reservas ilimitadas esta semana");
    await edgar.getByLabel("Opciones").selectOption("3");
    // el edgar ya llegó al límite: se usa a Edwin para la captura
    await edwin.goto(`${APP}/publicaciones/nueva?marca=${reserviId}`);
    await edwin.getByLabel("¿De qué quieres publicar?").fill("Lanzamos el plan Pro con reservas ilimitadas esta semana");
    await edwin.getByLabel("Opciones").selectOption("3");
    await edwin.getByRole("button", { name: "Generar opciones" }).click();
    await edwin.getByRole("button", { name: "Usar este texto" }).first().waitFor();
    await edwin.getByRole("button", { name: "Usar este texto" }).first().click();
    await edwin.screenshot({ path: path.join(SHOTS, "editor-claro.png"), fullPage: true });
    await admin.goto(`${APP}/marcas`);
    await admin.screenshot({ path: path.join(SHOTS, "marcas-claro.png"), fullPage: true });
    await admin.goto(`${APP}/marcas/${reserviId}`);
    await admin.screenshot({ path: path.join(SHOTS, "marca-claro.png"), fullPage: true });
    const dark = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark" });
    await dark.addCookies(await edwinCtx.cookies());
    const dp = await dark.newPage();
    await dp.goto(`${APP}/publicaciones/nueva?marca=${reserviId}`);
    await dp.screenshot({ path: path.join(SHOTS, "editor-oscuro.png"), fullPage: true });
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await mob.addCookies(await edwinCtx.cookies());
    const mp = await mob.newPage();
    await mp.goto(`${APP}/publicaciones/nueva?marca=${reserviId}`);
    await mp.screenshot({ path: path.join(SHOTS, "editor-movil.png"), fullPage: true });
    await dark.close();
    await mob.close();
  }
  void smartecId;
  void veraCtx;
  void auraCtx;
} catch (e) {
  fail("excepción en el recorrido", String(e?.stack ?? e).slice(0, 800));
  console.log("\n--- ultimas lineas de la app ---");
  console.log(logs.slice(-25).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [appA, appB]) child?.kill();
  await fake?.close().catch(() => {});
}

process.exit(finish());
