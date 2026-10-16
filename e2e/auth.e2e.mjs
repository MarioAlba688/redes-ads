// Prueba de extremo a extremo de Fase 1: instalacion, login, equipo, roles, sesiones.
// Maneja un navegador real contra la app y consulta MySQL para verificar el resultado.
// Instrucciones en README.md ("Pruebas de extremo a extremo").
//
// ATENCION: VACIA la base de datos antes de empezar. Solo corre contra una base cuyo nombre
// termine en "_test".

import fs from "node:fs";
import mariadb from "mariadb";
import { chromium } from "playwright-core";
import { createDb } from "./helpers.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "codigo-de-prueba-123";
const DB_URL = process.env.E2E_DATABASE_URL;

const ADMIN = { name: "Mario Alba", email: "mario@example.com", pass: "clave-admin-2026" };
const ADMIN_NEW_PASS = "nueva-clave-2026";
const ANA = { name: "Ana Perez", email: "ana@example.com", pass: "clave-ana-2026x" };

// --- Seguridad: nunca tocar una base de datos real ---------------------------
if (!DB_URL) {
  console.error("Falta E2E_DATABASE_URL (ej. mysql://root:@127.0.0.1:3307/redes_test).");
  process.exit(2);
}
const dbUrl = new URL(DB_URL);
const dbName = decodeURIComponent(dbUrl.pathname.slice(1));
if (!dbName.endsWith("_test")) {
  console.error(`Por seguridad, la base de datos debe terminar en "_test" (recibido: "${dbName}").`);
  process.exit(2);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) {
    console.error("No encontre Chrome/Edge. Define CHROME_PATH con la ruta al ejecutable.");
    process.exit(2);
  }
  return found;
}

async function sql(q, params = []) {
  const c = await mariadb.createConnection({
    host: dbUrl.hostname,
    port: dbUrl.port ? Number(dbUrl.port) : 3306,
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbName,
  });
  try {
    return await c.query(q, params);
  } finally {
    await c.end();
  }
}

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
}

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`La app no responde en ${BASE}. ¿Esta arrancada (npm start)?`);
}

async function login(page, { email, pass }) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(pass);
  await page.getByRole("button", { name: "Entrar" }).click();
}

// La base es *_test (verificado arriba): se vacia para poder repetir la prueba cuantas veces haga falta.
await createDb(dbUrl).reset();

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
try {
  await waitServer();
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();

  // 1. Sin sesion -> /login
  await admin.goto(`${BASE}/`);
  check("sin cookie, / redirige a /login", admin.url().endsWith("/login"), admin.url());
  await admin.goto(`${BASE}/cuentas`);
  check("sin cookie, /cuentas redirige a /login", admin.url().endsWith("/login"));
  await admin.goto(`${BASE}/equipo`);
  check("sin cookie, /equipo redirige a /login", admin.url().endsWith("/login"));

  // 2. Login sin usuarios ofrece crear el administrador
  await admin.goto(`${BASE}/login`);
  check("login sin usuarios ofrece crear administrador", await admin.getByText("Crea la cuenta de administrador").isVisible());

  // 3. Cabeceras de seguridad
  const headRes = await fetch(`${BASE}/login`);
  check("cabecera X-Frame-Options: DENY", headRes.headers.get("x-frame-options") === "DENY");
  check("cabecera X-Content-Type-Options: nosniff", headRes.headers.get("x-content-type-options") === "nosniff");
  check("no se expone X-Powered-By", headRes.headers.get("x-powered-by") === null);

  // 4. Setup: validaciones
  await admin.goto(`${BASE}/setup`);
  await admin.getByLabel("Código de instalación").fill("codigo-equivocado");
  await admin.getByLabel("Tu nombre").fill(ADMIN.name);
  await admin.getByLabel("Correo").fill(ADMIN.email);
  await admin.getByLabel("Contraseña", { exact: true }).fill(ADMIN.pass);
  await admin.getByLabel("Repite la contraseña").fill(ADMIN.pass);
  await admin.getByRole("button", { name: "Crear administrador" }).click();
  await admin.getByText("El código de instalación no es correcto.").waitFor();
  check("setup rechaza código de instalación incorrecto", true);
  check("no se creó ningún usuario con código incorrecto", Number((await sql("SELECT COUNT(*) c FROM User"))[0].c) === 0);
  check("tras el error se conservan nombre y correo", (await admin.getByLabel("Tu nombre").inputValue()) === ADMIN.name && (await admin.getByLabel("Correo").inputValue()) === ADMIN.email);
  check("el código incorrecto NO se repinta", (await admin.getByLabel("Código de instalación").inputValue()) === "");
  check("las contraseñas se vacían tras el error", (await admin.getByLabel("Contraseña", { exact: true }).inputValue()) === "");

  await admin.getByLabel("Código de instalación").fill(SETUP_TOKEN);
  await admin.getByLabel("Contraseña", { exact: true }).fill("corta1");
  await admin.getByLabel("Repite la contraseña").fill("corta1");
  await admin.getByRole("button", { name: "Crear administrador" }).click();
  await admin.getByText("al menos 10 caracteres").first().waitFor();
  check("setup rechaza contraseña corta", true);
  check("con código correcto, el código se conserva y no hay que repetirlo", (await admin.getByLabel("Código de instalación").inputValue()) === SETUP_TOKEN);

  await admin.getByLabel("Contraseña", { exact: true }).fill(ADMIN.pass);
  await admin.getByLabel("Repite la contraseña").fill("otra-clave-distinta1");
  await admin.getByRole("button", { name: "Crear administrador" }).click();
  await admin.getByText("Las contraseñas no coinciden.").waitFor();
  check("setup rechaza contraseñas que no coinciden", true);

  await admin.getByLabel("Contraseña", { exact: true }).fill(ADMIN.pass);
  await admin.getByLabel("Repite la contraseña").fill(ADMIN.pass);
  await admin.getByRole("button", { name: "Crear administrador" }).click();
  await admin.waitForURL(`${BASE}/`);
  await admin.getByText("Hola, Mario").waitFor();
  check("setup crea al administrador y entra al panel", true);

  const cookies = await adminCtx.cookies();
  const sess = cookies.find((c) => c.name === "redes_session");
  check("cookie de sesión existe", !!sess);
  check("cookie httpOnly", sess?.httpOnly === true);
  check("cookie SameSite=Lax", sess?.sameSite === "Lax", String(sess?.sameSite));
  check("cookie 'secure' coincide con el protocolo de APP_URL", sess?.secure === BASE.startsWith("https://"));

  const u = (await sql("SELECT role, passwordHash FROM User WHERE email=?", [ADMIN.email]))[0];
  check("el usuario es ADMIN", u?.role === "ADMIN");
  check("contraseña guardada con bcrypt, no en texto plano", u?.passwordHash?.startsWith("$2") && !u.passwordHash.includes(ADMIN.pass));
  const s = (await sql("SELECT tokenHash FROM Session LIMIT 1"))[0];
  check("en BD solo hay el hash del token de sesión (hex 64)", /^[0-9a-f]{64}$/.test(s?.tokenHash ?? ""));
  check("el token de la cookie no se guarda tal cual", s?.tokenHash !== sess?.value);
  const h = (await sql("SELECT TIMESTAMPDIFF(HOUR, UTC_TIMESTAMP(), expiresAt) h FROM Session LIMIT 1"))[0].h;
  check("expiración de sesión ≈ 7 días en UTC (zona horaria correcta)", Number(h) >= 166 && Number(h) <= 168, `${h} h`);

  await admin.goto(`${BASE}/setup`);
  check("/setup deja de estar disponible tras crear el primer usuario", !admin.url().endsWith("/setup"), admin.url());

  // 5. Panel y cuentas
  await admin.goto(`${BASE}/`);
  check("panel muestra 'Personas en el equipo'", await admin.getByText("Personas en el equipo").isVisible());
  await admin.goto(`${BASE}/cuentas`);
  for (const p of ["Meta", "Google Ads", "TikTok", "LinkedIn"]) {
    check(`cuentas muestra la plataforma ${p}`, await admin.getByRole("heading", { name: p, exact: true }).isVisible());
  }
  check("cuentas muestra estado vacío", await admin.getByText("Todavía no hay cuentas conectadas").isVisible());
  // Google Ads y TikTok se conectan desde la Fase 4 (sin credenciales en el servidor explican que falta configurarlas); solo LinkedIn sigue deshabilitado (Fase 5).
  check("LinkedIn sigue con la conexión deshabilitada (Fase 5)", (await admin.locator("button[disabled]").count()) === 1 && (await admin.getByRole("button", { name: "Disponible en la Fase 5" }).isDisabled()));
  // Depende del .env con el que se arranco la app: sin META_APP_ID/SECRET explica que falta configurarlo; con ellos, ofrece conectar.
  check(
    "Meta muestra su estado: aviso de configuración o botón de conectar",
    (await admin.getByText(/Falta crear la app en Meta for Developers/).isVisible()) || (await admin.getByRole("link", { name: /Conectar Meta/ }).count()) === 1,
  );

  // 6. Invitar
  await admin.goto(`${BASE}/equipo`);
  await admin.locator("#invite-email").fill("no-es-un-correo");
  await admin.getByRole("button", { name: "Crear invitación" }).click();
  await admin.getByText("Escribe un correo válido.").waitFor();
  check("invitación rechaza correo inválido", true);

  await admin.locator("#invite-email").fill(ADMIN.email);
  await admin.getByRole("button", { name: "Crear invitación" }).click();
  await admin.getByText("Ya hay una cuenta con ese correo.").waitFor();
  check("invitación rechaza correo ya registrado", true);

  await admin.locator("#invite-email").fill(ANA.email);
  await admin.locator("#invite-role").selectOption("EDITOR");
  await admin.getByRole("button", { name: "Crear invitación" }).click();
  const linkInput = admin.getByLabel("Link de invitación");
  await linkInput.waitFor();
  const inviteLink = await linkInput.inputValue();
  check("se muestra el link de invitación", inviteLink.startsWith(`${BASE}/invite/`), inviteLink.slice(0, 50));
  const inv = (await sql("SELECT tokenHash FROM Invitation WHERE email=?", [ANA.email]))[0];
  const token = inviteLink.split("/invite/")[1];
  check("en BD solo se guarda el hash del token de invitación", inv && inv.tokenHash !== token && /^[0-9a-f]{64}$/.test(inv.tokenHash));

  // 7. Ana acepta la invitación (otro navegador)
  const anaCtx = await browser.newContext();
  const ana = await anaCtx.newPage();
  await ana.goto(inviteLink);
  check("la página de invitación muestra el rol y el correo", (await ana.getByText(ANA.email).isVisible()) && (await ana.getByText("Editor").first().isVisible()));
  await ana.getByLabel("Tu nombre").fill(ANA.name);
  await ana.getByLabel("Contraseña", { exact: true }).fill("corta");
  await ana.getByLabel("Repite la contraseña").fill("corta");
  await ana.getByRole("button", { name: "Crear mi cuenta" }).click();
  await ana.getByText("al menos 10 caracteres").first().waitFor();
  check("aceptar invitación valida la contraseña", true);
  check("aceptar invitación conserva el nombre tras el error", (await ana.getByLabel("Tu nombre").inputValue()) === ANA.name);
  await ana.getByLabel("Contraseña", { exact: true }).fill(ANA.pass);
  await ana.getByLabel("Repite la contraseña").fill(ANA.pass);
  await ana.getByRole("button", { name: "Crear mi cuenta" }).click();
  await ana.waitForURL(`${BASE}/`);
  await ana.getByText("Hola, Ana").waitFor();
  check("Ana acepta la invitación y entra", true);
  check("Ana (Editor) no ve 'Equipo' en el menú", (await ana.getByRole("link", { name: "Equipo" }).count()) === 0);
  await ana.goto(`${BASE}/equipo`);
  check("Ana abriendo /equipo va a /sin-permiso", ana.url().endsWith("/sin-permiso"), ana.url());
  check("Ana ve el mensaje 'No tienes permiso'", await ana.getByText("No tienes permiso").isVisible());
  check("Ana quedó con rol EDITOR en BD", (await sql("SELECT role FROM User WHERE email=?", [ANA.email]))[0]?.role === "EDITOR");

  const reuse = await (await browser.newContext()).newPage();
  await reuse.goto(inviteLink);
  check("el link de invitación ya usado deja de funcionar", await reuse.getByText("Invitación no válida").isVisible());

  // 8. Admin cambia el rol de Ana
  await admin.goto(`${BASE}/equipo`);
  const row = admin.locator("tr", { hasText: ANA.email });
  check("el admin ve a Ana en la lista", await row.isVisible());
  const me = admin.locator("tr", { hasText: ADMIN.email });
  check("el admin no puede cambiar su propio rol (select deshabilitado)", await me.locator("select").isDisabled());
  check("el admin no ve botón de desactivarse a sí mismo", (await me.getByRole("button", { name: "Desactivar" }).count()) === 0);
  await row.locator("select").selectOption("APPROVER");
  await admin.waitForTimeout(1000);
  const roleNow = (await sql("SELECT role FROM User WHERE email=?", [ANA.email]))[0].role;
  check("cambio de rol a Aprobador persiste en BD", roleNow === "APPROVER", roleNow);
  await ana.goto(`${BASE}/perfil`);
  check("el cambio de rol se refleja de inmediato para Ana", await ana.getByText("Aprobador").first().isVisible());

  // 9. Desactivar y reactivar a Ana
  const countSessions = async (email) =>
    Number((await sql("SELECT COUNT(*) c FROM Session s JOIN User u ON u.id=s.userId WHERE u.email=?", [email]))[0].c);
  const sessionsBefore = await countSessions(ANA.email);
  await row.getByRole("button", { name: "Desactivar" }).click();
  await admin.waitForTimeout(1000);
  const sessionsAfter = await countSessions(ANA.email);
  check("al desactivar se borran las sesiones de Ana", sessionsBefore >= 1 && sessionsAfter === 0, `${sessionsBefore} -> ${sessionsAfter}`);
  await ana.goto(`${BASE}/`);
  check("Ana desactivada pierde el acceso al instante", ana.url().endsWith("/login"), ana.url());
  await login(ana, ANA);
  await ana.getByText("Correo o contraseña incorrectos.").waitFor();
  check("Ana desactivada no puede volver a entrar (mensaje genérico)", true);

  await admin.reload();
  await admin.locator("tr", { hasText: ANA.email }).getByRole("button", { name: "Reactivar" }).click();
  await admin.waitForTimeout(1000);
  await login(ana, ANA);
  await ana.waitForURL(`${BASE}/`);
  check("tras reactivarla, Ana puede entrar", true);

  // 10. Bloqueo por intentos fallidos
  const lock = await (await browser.newContext()).newPage();
  for (let i = 0; i < 5; i++) {
    await login(lock, { email: ANA.email, pass: "clave-incorrecta-" + i });
    await lock.getByText("Correo o contraseña incorrectos.").waitFor();
  }
  await login(lock, ANA);
  await lock.getByText(/Demasiados intentos fallidos/).waitFor();
  check("tras 5 fallos la cuenta se bloquea aunque la clave sea correcta", true);
  check("el login conserva el correo tras un error", (await lock.getByLabel("Correo").inputValue()) === ANA.email);
  check("el bloqueo se guarda en BD (lockedUntil futuro)", (await sql("SELECT lockedUntil > UTC_TIMESTAMP() ok FROM User WHERE email=?", [ANA.email]))[0].ok == 1);
  await sql("UPDATE User SET lockedUntil=NULL, failedLogins=0 WHERE email=?", [ANA.email]);

  await login(lock, { email: "nadie@example.com", pass: "cualquier-cosa-123" });
  await lock.getByText("Correo o contraseña incorrectos.").waitFor();
  check("correo inexistente da el mismo mensaje genérico", true);

  // 11. Cambio de contraseña
  const admin2 = await (await browser.newContext()).newPage();
  await login(admin2, ADMIN);
  await admin2.waitForURL(`${BASE}/`);
  check("el admin tiene 2 sesiones abiertas (2 dispositivos)", (await countSessions(ADMIN.email)) === 2);

  await admin.goto(`${BASE}/perfil`);
  await admin.getByLabel("Contraseña actual").fill("no-es-esta-clave-1");
  await admin.getByLabel("Contraseña nueva", { exact: true }).fill(ADMIN_NEW_PASS);
  await admin.getByLabel("Repite la contraseña nueva").fill(ADMIN_NEW_PASS);
  await admin.getByRole("button", { name: "Cambiar contraseña" }).click();
  await admin.getByText("La contraseña actual no es correcta.").waitFor();
  check("cambiar contraseña exige la actual correcta", true);

  await admin.getByLabel("Contraseña actual").fill(ADMIN.pass);
  await admin.getByLabel("Contraseña nueva", { exact: true }).fill(ADMIN_NEW_PASS);
  await admin.getByLabel("Repite la contraseña nueva").fill(ADMIN_NEW_PASS);
  await admin.getByRole("button", { name: "Cambiar contraseña" }).click();
  await admin.getByText("Contraseña actualizada.").waitFor();
  check("cambio de contraseña exitoso", true);
  check("se cerraron las demás sesiones y se conservó la actual", (await countSessions(ADMIN.email)) === 1);
  await admin2.goto(`${BASE}/`);
  check("el otro dispositivo queda fuera tras cambiar la contraseña", admin2.url().endsWith("/login"), admin2.url());
  await admin.goto(`${BASE}/`);
  check("la sesión actual sigue activa", await admin.getByText("Hola, Mario").isVisible());

  // 12. Historial
  await admin.goto(`${BASE}/equipo`);
  check("el historial muestra actividad", (await admin.getByText("Actividad reciente").isVisible()) && (await admin.getByText("cambió el rol de").first().isVisible()));
  check("los accesos fallidos se muestran sin atribuirlos a nadie", await admin.getByText("Intento de acceso fallido").first().isVisible());
  const audit = await sql("SELECT action, COUNT(*) c FROM AuditLog GROUP BY action");
  check("la auditoría registró login, invitaciones y cambios", audit.length >= 6, audit.map((a) => `${a.action}=${a.c}`).join(", "));

  // 13. Logout
  await admin.getByRole("button", { name: "Cerrar sesión" }).click();
  await admin.waitForURL(`${BASE}/login`);
  check("logout borra la cookie", !(await adminCtx.cookies()).find((c) => c.name === "redes_session"));
  await admin.goto(`${BASE}/equipo`);
  check("tras cerrar sesión, /equipo redirige a /login", admin.url().endsWith("/login"));
  await login(admin, { email: ADMIN.email, pass: ADMIN_NEW_PASS });
  await admin.waitForURL(`${BASE}/`);
  check("se puede entrar con la contraseña nueva", true);

  // 14. Cookie inventada
  const fakeCtx = await browser.newContext();
  await fakeCtx.addCookies([{ name: "redes_session", value: "token-inventado-que-no-existe-en-la-bd-1234567890", url: BASE }]);
  const fake = await fakeCtx.newPage();
  await fake.goto(`${BASE}/`);
  check("cookie inventada no da acceso (sin bucle de redirecciones)", fake.url().endsWith("/login"), fake.url());
  check("con cookie inválida el login se muestra normal", await fake.getByRole("button", { name: "Entrar" }).isVisible());
} catch (e) {
  console.error("EXCEPCIÓN:", e);
  results.push({ name: "excepción en el recorrido", ok: false, extra: String(e).slice(0, 300) });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pruebas OK`);
if (failed.length) {
  console.log("FALLARON:");
  for (const f of failed) console.log(" -", f.name, f.extra);
  process.exit(1);
}
