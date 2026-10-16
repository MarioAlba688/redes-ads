// Prueba de extremo a extremo de los varios motores de IA (Claude, GPT, Gemini): configuracion desde la pantalla
// «Motores de IA», claves cifradas, prueba de conexion, listado de modelos, selector en el editor, errores propios de
// cada API, limite diario compartido y permisos. Usa tres servidores simulados (no gasta dinero ni necesita claves).
// Arranca la app dos veces (hace falta `npm run build`):
//   - A: sin clave de Claude en el .env (todo se configura desde la pantalla).
//   - B: con ANTHROPIC_API_KEY en el .env (prueba el respaldo y que la clave guardada en la app manda sobre ella).
// VACIA la base de pruebas (solo corre contra una base *_test).

import { createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";
import { FAKE_API_KEY, FAKE_API_KEY_2, startFakeAnthropic } from "./fake-anthropic.mjs";
import { FAKE_GEMINI_KEY, startFakeGemini } from "./fake-gemini.mjs";
import { createChecker, createDb, findChrome, requireTestDb, startApp, waitReady } from "./helpers.mjs";
import { FAKE_OPENAI_KEY, startFakeOpenAi } from "./fake-openai.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_PORT = Number(process.env.E2E_ENGINES_PORT ?? 3340);
const PLAIN_PORT = APP_PORT + 1;
const FAKE_PORTS = { anthropic: 4040, openai: 4041, gemini: 4042 };
const APP = `http://localhost:${APP_PORT}`;
const PLAIN = `http://localhost:${PLAIN_PORT}`;
const SETUP_TOKEN = "codigo-de-prueba-123";
const SHOTS = process.env.E2E_SHOTS_DIR;
const LIMIT = 30;

const ADMIN = { name: "Mario Alba", email: "mario@example.com", pass: "clave-admin-2026" };
const USERS = {
  edgar: { id: "u-edgar-0001", name: "Edgar Editor", email: "edgar@example.com", pass: "clave-edgar-2026x", role: "EDITOR" },
  edwin: { id: "u-edwin-0001", name: "Edwin Editor", email: "edwin@example.com", pass: "clave-edwin-2026x", role: "EDITOR" },
  vera: { id: "u-vera-00001", name: "Vera Lectora", email: "vera@example.com", pass: "clave-vera-2026xx", role: "VIEWER" },
};
const BRAND = "brand-reservi";
const ALL_KEYS = [FAKE_API_KEY, FAKE_API_KEY_2, FAKE_OPENAI_KEY, FAKE_GEMINI_KEY];

const { raw: DB_URL, url: dbUrl } = requireTestDb();
const db = createDb(dbUrl);
const { check, fail, finish } = createChecker();

if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("Falta compilar la app: ejecuta `npm run build` antes de esta prueba.");
  process.exit(2);
}

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
/** Descifra con el mismo formato que src/lib/crypto.ts (v1.<iv>.<tag>.<datos>, AES-256-GCM, base64url). */
function decrypt(payload) {
  const [, iv, tag, data] = payload.split(".");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(ENCRYPTION_KEY, "base64"), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

const logs = [];
let fakes = {};
let appA;
let appB;
let browser;
try {
  await db.reset();
  fakes = {
    anthropic: await startFakeAnthropic(FAKE_PORTS.anthropic),
    openai: await startFakeOpenAi(FAKE_PORTS.openai),
    gemini: await startFakeGemini(FAKE_PORTS.gemini),
  };
  const baseEnv = {
    DATABASE_URL: DB_URL,
    SETUP_TOKEN,
    ENCRYPTION_KEY,
    E2E_DATABASE_URL: "",
    META_APP_ID: "",
    META_APP_SECRET: "",
    META_SCOPES: "",
    META_LOGIN_CONFIG_ID: "",
    AI_MODEL: "",
    AI_EFFORT: "",
    AI_DAILY_LIMIT: String(LIMIT),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORTS.anthropic}`,
    OPENAI_BASE_URL: `http://127.0.0.1:${FAKE_PORTS.openai}`,
    GEMINI_BASE_URL: `http://127.0.0.1:${FAKE_PORTS.gemini}`,
    WORKER_ENABLED: "false",
    TZ: "UTC",
  };
  appA = startApp({ root: ROOT, port: APP_PORT, logs, env: { ...baseEnv, APP_URL: APP, ANTHROPIC_API_KEY: "" } });
  appB = startApp({ root: ROOT, port: PLAIN_PORT, logs, env: { ...baseEnv, APP_URL: PLAIN, ANTHROPIC_API_KEY: FAKE_API_KEY } });
  await Promise.all([waitReady(APP), waitReady(PLAIN)]);

  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const newPage = async (viewport = { width: 1280, height: 1100 }, extra = {}) => {
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
  const sql = (q, p) => db.sql(q, p);
  const row = async (provider) => (await sql("SELECT * FROM AiProvider WHERE provider=?", [provider]))[0];
  const reqs = (name) => fakes[name].requests();
  const gens = async (userId) => sql("SELECT provider, model, inputTokens, outputTokens, ok, error FROM AiGeneration WHERE userId=? ORDER BY createdAt, id", [userId]);

  // La tarjeta de un motor en /ia y sus partes.
  const card = (page, id) => page.locator("div.rounded-xl").filter({ has: page.locator(`#engine-${id}`) });
  const cardText = async (page, id) => (await card(page, id).innerText()).replace(/\s+/g, " ");
  const press = (page, id, name) => card(page, id).getByRole("button", { name, exact: true }).click();
  const say = (page, id, re) => card(page, id).getByText(re).first();

  // ------------------------------------------------------------ 0. instalacion, usuarios y marca
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
    await sql("INSERT INTO User (id, email, name, passwordHash, role, active, failedLogins, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 0, NOW(3), NOW(3))", [u.id, u.email, u.name, bcrypt.hashSync(u.pass, 4), u.role]);
  }
  await sql("INSERT INTO Brand (id, name, description, language, avoid, timezone, createdAt, updatedAt) VALUES (?, 'Reservi', 'Sistema de reservas en línea para restaurantes y salones.', 'es', 'gratis', 'America/Bogota', NOW(3), NOW(3))", [BRAND]);
  await sql("INSERT INTO SocialAccount (id, platform, kind, externalId, name, status, accessTokenEnc, brandId, createdAt, updatedAt) VALUES ('acc-fb', 'META', 'FACEBOOK_PAGE', 'P-1', 'Reservi', 'ACTIVE', 'v1.a.b.c', ?, NOW(3), NOW(3))", [BRAND]);

  // ------------------------------------------------------------ 1. quien ve y puede usar la pantalla
  check("el administrador ve «Motores de IA» en el menú", (await admin.getByRole("link", { name: "Motores de IA" }).count()) === 1);
  const { ctx: edgarCtx, page: edgar } = await newPage();
  await loginAs(edgar, USERS.edgar);
  check("un editor no ve esa opción del menú", (await edgar.getByRole("link", { name: "Motores de IA" }).count()) === 0);
  await edgar.goto(`${APP}/ia`);
  check("y si abre la dirección a mano, no entra", edgar.url().endsWith("/sin-permiso"));
  const { page: vera } = await newPage();
  await loginAs(vera, USERS.vera);
  await vera.goto(`${APP}/ia`);
  check("solo lectura tampoco entra", vera.url().endsWith("/sin-permiso"));

  // ------------------------------------------------------------ 2. respaldo: ANTHROPIC_API_KEY del .env (app B)
  await admin.goto(`${PLAIN}/ia`);
  const envCard = await cardText(admin, "anthropic");
  check("con la clave de Claude en el .env, su tarjeta lo dice y está activa", /Activo/.test(envCard) && /Clave del archivo \.env/.test(envCard) && /Por defecto/.test(envCard));
  check("GPT y Gemini siguen sin clave (el .env no las da)", /Sin clave/.test(await cardText(admin, "openai")) && /Sin clave/.test(await cardText(admin, "gemini")));
  check("sin clave guardada no se ofrece «Quitar clave» (no hay nada que quitar en la app)", (await card(admin, "anthropic").getByRole("button", { name: "Quitar clave" }).count()) === 0);

  const generate = async (page, { base = APP, brief, engine, count = "1", wait }) => {
    await page.goto(`${base}/publicaciones/nueva?marca=${BRAND}`);
    await page.getByLabel("¿De qué quieres publicar?").fill(brief);
    await page.getByLabel("Opciones").selectOption(count);
    if (engine) await page.locator("#provider").selectOption(engine);
    await page.getByRole("button", { name: "Generar opciones" }).click();
    await page.getByText(wait).first().waitFor({ timeout: 30_000 });
  };
  await generate(edgar, { base: PLAIN, brief: "Respaldo con la clave del archivo .env", wait: /Usar este texto/ });
  check("con un solo motor el editor no muestra selector y genera con la clave del .env", (await edgar.locator("#provider").count()) === 0 && reqs("anthropic").at(-1)?.apiKey === FAKE_API_KEY);

  // ------------------------------------------------------------ 3. la app A empieza sin ningún motor
  await admin.goto(`${APP}/ia`);
  check("sin nada configurado, las tres tarjetas dicen «Sin clave»", (await Promise.all(["anthropic", "openai", "gemini"].map((id) => cardText(admin, id)))).every((t) => /Sin clave/.test(t)));
  check("y la pantalla explica que falta al menos un motor", await admin.getByText(/Todavía no hay ningún motor listo/).isVisible());
  await admin.goto(`${APP}/publicaciones/nueva?marca=${BRAND}`);
  check("al administrador, el editor le enlaza a «Motores de IA»", (await admin.getByText(/La IA todavía no está activada/).isVisible()) && (await admin.locator("main").getByRole("link", { name: "Motores de IA" }).count()) === 1);
  await edgar.goto(`${APP}/publicaciones/nueva?marca=${BRAND}`);
  check("a un editor le dice que pida a un administrador (sin enlace)", (await edgar.getByText(/Pídele a un administrador/).isVisible()) && (await edgar.locator("main").getByRole("link", { name: "Motores de IA" }).count()) === 0);

  // ------------------------------------------------------------ 4. configurar GPT (OpenAI)
  await admin.goto(`${APP}/ia`);
  await admin.locator("#key-openai").fill("tiene espacios dentro 12345");
  await press(admin, "openai", "Guardar");
  await say(admin, "openai", /no parece válida/).waitFor();
  check("una clave con espacios (pegada a medias) se rechaza con un mensaje claro", !(await row("openai")));

  await admin.locator("#key-openai").fill("");
  await press(admin, "openai", "Guardar");
  await say(admin, "openai", /Pega la clave de GPT \(OpenAI\)/).waitFor();
  check("activar un motor sin clave se rechaza", !(await row("openai")));

  await admin.locator("#key-openai").fill(FAKE_OPENAI_KEY);
  await press(admin, "openai", "Guardar");
  await say(admin, "openai", /quedó cifrada/).waitFor();
  const oa = await row("openai");
  check("la clave se guarda cifrada (no en texto claro) y se puede recuperar", oa.apiKeyEnc.startsWith("v1.") && !oa.apiKeyEnc.includes(FAKE_OPENAI_KEY) && decrypt(oa.apiKeyEnc) === FAKE_OPENAI_KEY);
  check("de la clave solo se guardan los últimos 4 caracteres, para reconocerla", oa.keyHint === FAKE_OPENAI_KEY.slice(-4) && oa.model === "gpt-6.1-sol" && oa.enabled == 1);
  check("tras guardar, el campo de la clave queda vacío", (await admin.locator("#key-openai").inputValue()) === "");
  const oaText = await cardText(admin, "openai");
  check("la tarjeta pasa a «Activo» y muestra cómo termina la clave", /Activo/.test(oaText) && oaText.includes(`termina en ${FAKE_OPENAI_KEY.slice(-4)}`));

  await press(admin, "openai", "Probar conexión");
  await say(admin, "openai", /Conexión correcta/).waitFor();
  const probe = reqs("openai").filter((r) => r.path === "/v1/responses").at(-1);
  check("probar la conexión hace una generación mínima con la clave y el modelo guardados", probe?.apiKey === FAKE_OPENAI_KEY && probe.body.model === "gpt-6.1-sol" && probe.body.store === false);
  check("y guarda el resultado de la prueba", (await row("openai")).lastTestOk == 1 && !!(await row("openai")).lastTestAt);

  await press(admin, "openai", "Cargar modelos");
  await say(admin, "openai", /3 modelos disponibles/).waitFor();
  const oaModels = await admin.locator("#models-openai option").evaluateAll((o) => o.map((x) => x.value));
  check("«Cargar modelos» lista solo los modelos de texto que ve la clave", JSON.stringify(oaModels) === JSON.stringify(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]), oaModels.join());

  await admin.locator("#model-openai").fill("modelo-inexistente");
  await press(admin, "openai", "Probar conexión");
  await say(admin, "openai", /«modelo-inexistente».*no existe/).waitFor();
  check("un modelo que no existe se explica y la prueba fallida queda registrada", (await row("openai")).lastTestOk == 0 && /no existe/.test((await row("openai")).lastError ?? ""));
  await admin.locator("#model-openai").fill("gpt-6-astra");
  await press(admin, "openai", "Guardar");
  await say(admin, "openai", /^Guardado\.$/).waitFor();
  const oa2 = await row("openai");
  check("al elegir otro modelo se guarda, se conserva la clave y se borra la prueba anterior", oa2.model === "gpt-6-astra" && decrypt(oa2.apiKeyEnc) === FAKE_OPENAI_KEY && oa2.lastTestOk === null);
  await admin.reload();
  check("al recargar, el modelo elegido sigue ahí y el campo de la clave está vacío", (await admin.locator("#model-openai").inputValue()) === "gpt-6-astra" && (await admin.locator("#key-openai").inputValue()) === "");

  // ------------------------------------------------------------ 5. configurar Gemini (con una clave mala primero)
  await admin.locator("#key-gemini").fill("AIzaSyEstaClaveNoEsValidaDeGemini00");
  await press(admin, "gemini", "Probar conexión");
  await say(admin, "gemini", /clave de Gemini \(Google\) no es válida/).waitFor();
  check("una clave mala se detecta aunque Google responda 400 y no 401", true);
  check("probar una clave escrita pero sin guardar no deja rastro en la base", !(await row("gemini")));
  const badGemini = reqs("gemini").at(-1);
  check("la clave viaja en una cabecera, nunca en la URL", badGemini.apiKey === "AIzaSyEstaClaveNoEsValidaDeGemini00" && !badGemini.search.includes("key="));

  await admin.locator("#key-gemini").fill(FAKE_GEMINI_KEY);
  await press(admin, "gemini", "Cargar modelos");
  await say(admin, "gemini", /3 modelos disponibles/).waitFor();
  const gModels = await admin.locator("#models-gemini option").evaluateAll((o) => o.map((x) => x.value));
  check("Gemini lista solo los modelos que generan texto (sin embeddings, imágenes ni el prefijo models/)", JSON.stringify(gModels) === JSON.stringify(["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-4-argon"]), gModels.join());
  await admin.locator("#model-gemini").fill("gemini-3.8-flash");
  await press(admin, "gemini", "Guardar");
  await say(admin, "gemini", /quedó cifrada/).waitFor();
  check("Gemini queda guardado y cifrado", decrypt((await row("gemini")).apiKeyEnc) === FAKE_GEMINI_KEY);
  await press(admin, "gemini", "Probar conexión");
  await say(admin, "gemini", /Conexión correcta/).waitFor();
  const gProbe = reqs("gemini").filter((r) => r.path.endsWith(":generateContent")).at(-1);
  check("la prueba de Gemini llama al modelo elegido en modo JSON y con la forma descrita", gProbe.path === "/v1beta/models/gemini-3.8-flash:generateContent" && gProbe.body.generationConfig.responseMimeType === "application/json" && gProbe.body.systemInstruction.parts[0].text.includes('{"posts":'));

  // ------------------------------------------------------------ 6. configurar Claude desde la app (B ya tiene otra en el .env)
  await admin.locator("#key-anthropic").fill(FAKE_API_KEY_2);
  await admin.locator("#model-anthropic").fill("claude-sonnet-5-5");
  await press(admin, "anthropic", "Guardar");
  await say(admin, "anthropic", /quedó cifrada/).waitFor();
  await press(admin, "anthropic", "Cargar modelos");
  await say(admin, "anthropic", /3 modelos disponibles/).waitFor();
  check("Claude lista sus modelos con la clave guardada", JSON.stringify(await admin.locator("#models-anthropic option").evaluateAll((o) => o.map((x) => x.value))) === JSON.stringify(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]));
  await press(admin, "anthropic", "Probar conexión");
  await say(admin, "anthropic", /Conexión correcta/).waitFor();
  check("la prueba de Claude usó la clave y el modelo configurados en la app", reqs("anthropic").filter((r) => r.path === "/v1/messages").at(-1)?.apiKey === FAKE_API_KEY_2);

  // ------------------------------------------------------------ 7. motor por defecto
  check("sin elegir uno, el primero disponible es el de por defecto", /Por defecto/.test(await cardText(admin, "anthropic")));
  await admin.locator("#default-engine").selectOption("gemini");
  await admin.getByRole("button", { name: "Guardar", exact: true }).first().click();
  await admin.getByText("Guardado.", { exact: true }).last().waitFor();
  check("el motor por defecto se guarda y la tarjeta lo muestra", (await row("gemini")).isDefault == 1 && /Por defecto/.test(await cardText(admin, "gemini")));
  await admin.reload();
  check("al recargar, Gemini sigue siendo el de por defecto y los otros no", /Por defecto/.test(await cardText(admin, "gemini")) && !/Por defecto/.test(await cardText(admin, "openai")) && (await admin.locator("#default-engine").inputValue()) === "gemini");
  await shot(admin, "motores-claro.png");

  // ------------------------------------------------------------ 8. generar con cada motor desde el editor
  await edgar.goto(`${APP}/publicaciones/nueva?marca=${BRAND}`);
  const options = await edgar.locator("#provider option").evaluateAll((o) => o.map((x) => ({ v: x.value, t: x.textContent })));
  check("con varios motores listos, el editor muestra el selector con sus nombres", options.map((o) => o.v).join() === "anthropic,openai,gemini" && options[1].t === "GPT (OpenAI)");
  check("y propone primero el de por defecto (Gemini)", (await edgar.locator("#provider").inputValue()) === "gemini");
  await shot(edgar, "editor-motores.png");

  const sys = (r) => JSON.stringify(r.body.systemInstruction ?? r.body.input ?? r.body.system);
  await generate(edgar, { brief: "Con el motor por defecto, Gemini", wait: /Usar este texto/ });
  const g1 = reqs("gemini").filter((r) => r.path.endsWith(":generateContent")).at(-1);
  check("sin tocar el selector se usa Gemini, con su clave, su modelo y el perfil de la marca", g1.apiKey === FAKE_GEMINI_KEY && g1.path.includes("gemini-3.8-flash") && sys(g1).includes("«Reservi»") && g1.body.contents[0].parts[0].text.includes("motor por defecto"));
  check("la respuesta se muestra con el motor y el modelo que la escribieron", await edgar.getByText("Escrito con Gemini (Google) · gemini-3.8-flash-001").isVisible());
  check("el texto es el de Gemini (sin el bloque de pensamiento) y lleva los hashtags limpios", (await edgar.locator("main aside").innerText()).includes("Gemini escribió: Con el motor por defecto") && /#reservi #Reservas/.test(await edgar.locator("main aside").innerText()) && !(await edgar.locator("main aside").innerText()).includes("Voy a redactar"));

  await generate(edgar, { brief: "Ahora con GPT por favor", engine: "openai", wait: /Usar este texto/ });
  const o1 = reqs("openai").filter((r) => r.path === "/v1/responses").at(-1);
  check("al elegir GPT se llama a OpenAI con su clave, el modelo guardado y esquema estricto", o1.apiKey === FAKE_OPENAI_KEY && o1.body.model === "gpt-6-astra" && o1.body.text.format.type === "json_schema" && o1.body.text.format.strict === true);
  check("y el resultado dice que lo escribió GPT", (await edgar.getByText(/Escrito con GPT \(OpenAI\) · gpt-6\.1-sol-2026-09-01/).isVisible()) && (await edgar.locator("main aside").innerText()).includes("GPT escribió: Ahora con GPT"));

  await generate(edgar, { brief: "Y con Claude también", engine: "anthropic", wait: /Usar este texto/ });
  const c1 = reqs("anthropic").filter((r) => r.path === "/v1/messages").at(-1);
  check("al elegir Claude se llama con la clave guardada en la app y su modelo", c1.apiKey === FAKE_API_KEY_2 && c1.body.model === "claude-sonnet-5-5" && (await edgar.getByText(/Escrito con Claude \(Anthropic\)/).isVisible()));

  const mine = await gens(USERS.edgar.id);
  const last3 = mine.slice(-3);
  check("cada generación queda registrada con su motor, modelo y tokens", last3.map((g) => g.provider).join() === "anthropic,gemini,openai" || last3.map((g) => g.provider).join() === "gemini,openai,anthropic", last3.map((g) => g.provider).join());
  const gemRow = mine.find((g) => g.provider === "gemini");
  check("en Gemini los tokens de «pensar» cuentan como salida (410 + 190)", Number(gemRow.inputTokens) === 950 && Number(gemRow.outputTokens) === 600);
  check("las generaciones anteriores a los varios motores y las del .env quedan como Claude", mine[0].provider === "anthropic");

  // Palabras vetadas: se descartan igual con cualquier motor.
  await generate(edgar, { brief: "Algo con palabra VETADA", engine: "openai", count: "2", wait: /Se descartaron 1 opción/ });
  check("las palabras vetadas de la marca se descartan también con GPT", (await edgar.getByRole("button", { name: "Usar este texto" }).count()) === 1);

  // Errores propios de cada API.
  await generate(edgar, { brief: "Algo con ERROR401 aquí", engine: "openai", wait: /clave de GPT \(OpenAI\) no es válida/ });
  check("GPT: clave inválida se explica y manda al administrador a «Motores de IA»", await edgar.getByText(/Revísala en Motores de IA/).isVisible());
  const b429 = reqs("openai").length;
  await generate(edgar, { brief: "Algo con LIMITE429 aquí", engine: "openai", wait: /demasiadas peticiones/ });
  check("GPT: ante un límite de uso reintenta (3 llamadas) y luego avisa", reqs("openai").length - b429 === 3, String(reqs("openai").length - b429));
  const bq = reqs("openai").length;
  await generate(edgar, { brief: "Algo con SINCREDITO aquí", engine: "openai", wait: /no tiene saldo/ });
  check("GPT: sin saldo se explica y no se reintenta", reqs("openai").length - bq === 1);
  await generate(edgar, { brief: "Algo para REHUSAR aquí", engine: "openai", wait: /no quiso redactar/ });
  await generate(edgar, { brief: "Algo CORTADO por tokens", engine: "openai", wait: /se cortó/ });
  await generate(edgar, { brief: "Algo de BASURA no JSON", engine: "openai", wait: /no se pudo leer/ });
  check("GPT: rechazo del modelo, respuesta cortada y texto que no es JSON tienen cada uno su aviso", true);
  const bf = reqs("openai").length;
  await generate(edgar, { brief: "Con un modelo de FORMATO400 antiguo", engine: "openai", wait: /Usar este texto/ });
  const fmt = reqs("openai").slice(bf).map((r) => r.body.text.format.type);
  check("GPT: si el modelo no admite el esquema estricto, se reintenta en modo JSON simple y funciona", fmt.join() === "json_schema,json_object", fmt.join());
  await generate(edgar, { brief: "Algo con SEGURIDAD aquí", engine: "gemini", wait: /no quiso redactar/ });
  await generate(edgar, { brief: "Algo BLOQUEADO por contenido", engine: "gemini", wait: /no quiso redactar/ });
  await generate(edgar, { brief: "Algo CORTADO por tokens", engine: "gemini", wait: /se cortó/ });
  await generate(edgar, { brief: "Algo de BASURA no JSON", engine: "gemini", wait: /no se pudo leer/ });
  const bg = reqs("gemini").length;
  await generate(edgar, { brief: "Algo con LIMITE429 aquí", engine: "gemini", wait: /demasiadas peticiones/ });
  check("Gemini: bloqueo de seguridad, petición bloqueada, respuesta cortada y no-JSON se explican; el límite de uso reintenta", reqs("gemini").length - bg === 3);
  const failed = (await gens(USERS.edgar.id)).filter((g) => !g.ok);
  check("los intentos fallidos también se registran, con su motor y sin la clave", failed.length >= 9 && failed.every((g) => g.provider && !ALL_KEYS.some((k) => (g.error ?? "").includes(k))));

  // ------------------------------------------------------------ 9. desactivar un motor: ya no se puede elegir (ni a la fuerza)
  await admin.goto(`${APP}/ia`);
  await card(admin, "openai").locator('input[name="enabled"]').uncheck();
  await press(admin, "openai", "Guardar");
  await say(admin, "openai", /^Guardado\.$/).waitFor();
  check("un motor desactivado conserva su clave pero deja de estar disponible", (await row("openai")).enabled == 0 && decrypt((await row("openai")).apiKeyEnc) === FAKE_OPENAI_KEY && /Desactivado/.test(await cardText(admin, "openai")));
  await edgar.goto(`${APP}/publicaciones/nueva?marca=${BRAND}`);
  check("en el editor solo quedan Claude y Gemini", (await edgar.locator("#provider option").evaluateAll((o) => o.map((x) => x.value))).join() === "anthropic,gemini");
  await edgar.getByLabel("¿De qué quieres publicar?").fill("Intento forzar un motor apagado");
  await edgar.locator("#provider").evaluate((s) => {
    const o = document.createElement("option");
    o.value = "openai";
    o.textContent = "GPT forzado";
    s.appendChild(o);
    s.value = "openai";
  });
  const beforeForced = reqs("openai").length;
  await edgar.getByRole("button", { name: "Generar opciones" }).click();
  await edgar.getByText(/ya no está disponible/).waitFor();
  check("elegir a la fuerza un motor apagado se rechaza en el servidor y no llama a la API", reqs("openai").length === beforeForced);
  await edgar.locator("#provider").evaluate((s) => {
    const o = document.createElement("option");
    o.value = "motor-inventado";
    s.appendChild(o);
    s.value = "motor-inventado";
  });
  await edgar.getByRole("button", { name: "Generar opciones" }).click();
  await edgar.getByText(/Motor de IA no válido/).waitFor();
  check("un motor inventado también se rechaza", true);

  // ------------------------------------------------------------ 10. quitar una clave
  await admin.goto(`${APP}/ia`);
  admin.once("dialog", (d) => d.accept());
  await press(admin, "gemini", "Quitar clave");
  await say(admin, "gemini", /Clave eliminada/).waitFor();
  const gone = await row("gemini");
  check("quitar la clave la borra de la base y apaga el motor", gone.apiKeyEnc === null && gone.keyHint === null && gone.enabled == 0 && gone.isDefault == 0);
  check("la tarjeta vuelve a «Sin clave» y se desmarca la casilla de disponible", /Sin clave/.test(await cardText(admin, "gemini")) && !(await card(admin, "gemini").locator('input[name="enabled"]').isChecked()));
  await edgar.goto(`${APP}/publicaciones/nueva?marca=${BRAND}`);
  check("sin su motor por defecto, el editor propone el primero disponible (Claude) y sin selector", (await edgar.locator("#provider").count()) === 0 && (await edgar.locator('input[name="provider"]').inputValue()) === "anthropic");

  // ------------------------------------------------------------ 11. la clave guardada manda sobre la del .env (app B)
  await generate(edgar, { base: PLAIN, brief: "Prioridad de la clave guardada", wait: /Usar este texto/ });
  check("con clave en el .env y otra guardada en la app, se usa la de la app", reqs("anthropic").filter((r) => r.path === "/v1/messages").at(-1)?.apiKey === FAKE_API_KEY_2);

  // ------------------------------------------------------------ 12. limite diario compartido entre motores
  const { page: edwin } = await newPage();
  await loginAs(edwin, USERS.edwin);
  await admin.goto(`${APP}/ia`);
  await card(admin, "openai").locator('input[name="enabled"]').check();
  await press(admin, "openai", "Guardar");
  await say(admin, "openai", /^Guardado\.$/).waitFor();
  for (let i = 0; i < LIMIT - 1; i++) {
    await sql("INSERT INTO AiGeneration (id, userId, brandId, provider, model, inputTokens, outputTokens, ok, createdAt) VALUES (?, ?, ?, 'openai', 'gpt-x', 1, 1, 1, UTC_TIMESTAMP(3))", [`seed-${i}`, USERS.edwin.id, BRAND]);
  }
  await edwin.goto(`${APP}/publicaciones/nueva?marca=${BRAND}`);
  check("lo gastado con GPT cuenta para el límite de la persona", await edwin.getByText(`Llevas ${LIMIT - 1} de ${LIMIT} generaciones`).isVisible());
  await edwin.getByLabel("¿De qué quieres publicar?").fill("La última generación del día con Gemini");
  await edwin.locator("#provider").selectOption("anthropic");
  await edwin.getByRole("button", { name: "Generar opciones" }).click();
  await edwin.getByRole("button", { name: "Usar este texto" }).first().waitFor();
  check("con otro motor se sigue contando: llega al límite", await edwin.getByText(`Llevas ${LIMIT} de ${LIMIT} generaciones`).isVisible() && (await edwin.getByRole("button", { name: "Generar opciones" }).isDisabled()));
  const callsBefore = reqs("openai").length + reqs("gemini").length + reqs("anthropic").length;
  await edwin.getByLabel("¿De qué quieres publicar?").fill("Intento número treinta y uno con otro motor");
  await edwin.locator("#provider").selectOption("openai");
  await edwin.getByRole("button", { name: "Generar opciones" }).evaluate((b) => (b.disabled = false));
  await edwin.getByRole("button", { name: "Generar opciones" }).click();
  await edwin.getByText(new RegExp(`límite de ${LIMIT} generaciones`)).waitFor();
  check("cambiar de motor no esquiva el límite: lo exige el servidor y no llama a ninguna API", reqs("openai").length + reqs("gemini").length + reqs("anthropic").length === callsBefore);

  // ------------------------------------------------------------ 13. seguridad: acciones fabricadas y secretos
  let captured = null;
  const grab = (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) captured = { url: r.url(), headers: r.headers(), body: r.postDataBuffer() };
  };
  await admin.goto(`${APP}/ia`);
  await admin.locator("#model-openai").fill("gpt-6-luna");
  admin.on("request", grab);
  await press(admin, "openai", "Guardar");
  await say(admin, "openai", /^Guardado\.$/).waitFor();
  admin.off("request", grab);
  check("se capturó la acción real «guardar motor»", !!captured?.headers["next-action"] && captured.body.toString("latin1").includes("gpt-6-luna"));
  if (captured) {
    const forged = Buffer.from(captured.body.toString("latin1").split("gpt-6-luna").join("modelo-forjado"), "latin1");
    const hop = new Set(["cookie", "content-length", "host", "connection", "accept-encoding"]);
    const headers = Object.fromEntries(Object.entries(captured.headers).filter(([k]) => !hop.has(k)));
    const asEdgar = await edgarCtx.request.post(captured.url, { headers, data: forged });
    check("un editor no puede cambiar un motor fabricando la petición: el servidor lo rechaza", (await asEdgar.text()).includes("No tienes permiso para hacer esto.") && (await row("openai")).model === "gpt-6-luna");
    const asAnon = await fetch(captured.url, { method: "POST", headers, body: forged, redirect: "manual" });
    await asAnon.arrayBuffer();
    check("sin sesión tampoco", (await row("openai")).model === "gpt-6-luna");
  }

  const pages = [];
  for (const u of ["/ia", `/publicaciones/nueva?marca=${BRAND}`, "/publicaciones", "/equipo"]) pages.push(await (await adminCtx.request.get(`${APP}${u}`)).text());
  const allHtml = pages.join("\n");
  check("ninguna pantalla contiene las claves completas ni su versión cifrada", !ALL_KEYS.some((k) => allHtml.includes(k)) && !(await sql("SELECT apiKeyEnc FROM AiProvider WHERE apiKeyEnc IS NOT NULL")).some((r) => allHtml.includes(r.apiKeyEnc)));
  const audits = await sql("SELECT action, target, detail FROM AuditLog");
  const kinds = new Set(audits.map((a) => a.action));
  check("la auditoría registra guardar, probar, quitar y elegir el motor por defecto", ["ai.engine_saved", "ai.engine_tested", "ai.engine_key_removed", "ai.default_engine_set", "ai.generated"].every((k) => kinds.has(k)), [...kinds].join());
  check("la auditoría no contiene ninguna clave", !ALL_KEYS.some((k) => JSON.stringify(audits).includes(k)));
  check("los registros de la app no contienen ninguna clave", !ALL_KEYS.some((k) => logs.join("\n").includes(k)));
  const actual = (await sql("SELECT provider, updatedById FROM AiProvider")).every((r) => r.updatedById);
  check("cada motor guarda quién lo configuró por última vez", actual);

  // ------------------------------------------------------------ 14. capturas
  if (SHOTS) {
    const dark = await browser.newContext({ viewport: { width: 1280, height: 1100 }, colorScheme: "dark" });
    await dark.addCookies(await adminCtx.cookies());
    const dp = await dark.newPage();
    await dp.goto(`${APP}/ia`);
    await shot(dp, "motores-oscuro.png");
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await mob.addCookies(await adminCtx.cookies());
    const mp = await mob.newPage();
    await mp.goto(`${APP}/ia`);
    await shot(mp, "motores-movil.png");
    await dark.close();
    await mob.close();
  }
} catch (e) {
  fail("excepción en el recorrido", String(e?.stack ?? e).slice(0, 900));
  console.log("\n--- ultimas lineas de la app ---");
  console.log(logs.slice(-30).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [appA, appB]) child?.kill();
  for (const f of Object.values(fakes)) await f?.close().catch(() => {});
}

process.exit(finish());
