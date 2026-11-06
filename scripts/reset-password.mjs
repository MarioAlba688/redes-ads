// Restablece la contraseña de una persona directamente en la base de datos. Sirve cuando se olvidó la del
// administrador: la app no tiene «olvidé mi contraseña» (no envía correos) y ni siquiera otro administrador puede
// cambiar la de alguien más desde Equipo.
//
// Se ejecuta en una terminal, dentro de la carpeta de la app (donde está el archivo .env con DATABASE_URL):
//
//     npm run admin:reset-password
//
// Muestra a quién va a cambiar y en qué base de datos, pide confirmación, y además quita el bloqueo por intentos
// fallidos y cierra las sesiones abiertas de esa persona. La contraseña nueva se escribe a mano, sin mostrarse, y no se
// guarda en ningún archivo ni en el historial de la terminal. Quien ejecuta esto ya tiene acceso a la base de datos
// (la clave está en .env): no abre ninguna puerta nueva.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import mariadb from "mariadb";

/** El mismo costo que usa la app (src/lib/password.ts). */
const COST = 12;

/**
 * Convierte DATABASE_URL en la configuracion del driver, igual que src/lib/db-config.ts (copiado aqui porque ese archivo
 * solo se puede importar desde Next.js). tests/reset-password-script.test.ts comprueba que dan lo mismo.
 */
export function parseDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const mode = url.searchParams.get("sslaccept");
  const caPath = url.searchParams.get("sslcert");
  let ssl;
  if (mode || caPath) {
    if (mode && mode !== "strict" && mode !== "accept_invalid_certs") {
      throw new Error('DATABASE_URL: sslaccept debe ser "strict" o "accept_invalid_certs".');
    }
    let ca;
    if (caPath) {
      try {
        ca = readFileSync(caPath);
      } catch {
        throw new Error(`DATABASE_URL: no pude leer el certificado indicado en sslcert (${caPath}).`);
      }
    }
    ssl = { rejectUnauthorized: mode !== "accept_invalid_certs", ...(ca ? { ca } : {}) };
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl,
  };
}

/** Motivo por el que una contraseña no vale, o null. Mismas reglas que passwordSchema de src/lib/password.ts. */
export function passwordProblem(password) {
  if (password.length < 10) return "La contraseña debe tener al menos 10 caracteres.";
  if (new TextEncoder().encode(password).length > 72) return "La contraseña es demasiado larga (máximo 72 bytes).";
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return "Debe incluir al menos una letra y un número.";
  return null;
}

function stop(message, code = 1) {
  console.error(`\n${message}`);
  process.exit(code);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Lee una linea sin mostrar lo que se escribe (para la contraseña). */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          finish();
          return resolve(value);
        }
        if (c === "\u0003") {
          finish();
          return reject(new Error("cancelado"));
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) stop("No encontré DATABASE_URL. Ejecuta este comando dentro de la carpeta de la app, donde está el archivo .env.");

  let config;
  try {
    config = parseDatabaseUrl(databaseUrl);
  } catch (e) {
    return stop(e instanceof Error ? e.message : "DATABASE_URL no es válida.");
  }
  console.log(`Base de datos: «${config.database}» en ${config.host}:${config.port}`);

  let conn;
  try {
    conn = await mariadb.createConnection({ ...config, connectTimeout: 15_000 });
  } catch (e) {
    return stop(
      `No pude conectarme a la base de datos (${e?.code ?? "error"}). Revisa que DATABASE_URL del .env sea la correcta, que el servidor acepte conexiones desde este equipo y que tengas internet.`,
    );
  }

  try {
    const users = await conn.query("SELECT id, email, name, role, active FROM `User` ORDER BY FIELD(role, 'ADMIN', 'APPROVER', 'EDITOR', 'VIEWER'), email");
    if (users.length === 0) stop("No hay usuarios en esa base de datos. Para crear el primer administrador abre la app en /setup.");

    console.log("\nPersonas registradas:");
    for (const u of users) console.log(`  ${u.email}  ·  ${u.name}  ·  ${u.role}${u.active ? "" : "  (desactivada)"}`);

    if (!process.stdin.isTTY) stop("Ejecuta este comando en una terminal (necesita que escribas la contraseña a mano).");

    const email = (await ask("\nCorreo de la persona a la que le vas a cambiar la contraseña: ")).toLowerCase();
    const user = users.find((u) => String(u.email).toLowerCase() === email);
    if (!user) stop(`No hay nadie con el correo «${email}». Copia uno de la lista de arriba.`);

    const first = await askHidden("Contraseña nueva (mínimo 10 caracteres, con letras y números): ");
    const problem = passwordProblem(first);
    if (problem) stop(`${problem} No se cambió nada.`);
    const second = await askHidden("Repítela: ");
    if (first !== second) stop("Las contraseñas no coinciden. No se cambió nada.");

    console.log(`\nVas a cambiar la contraseña de ${user.name} <${user.email}> (${user.role}) en la base «${config.database}» de ${config.host}.`);
    if (!user.active) console.log("Ojo: esa cuenta está desactivada; aunque cambies la contraseña no podrá entrar hasta que un administrador la reactive en Equipo.");
    const answer = (await ask("Escribe SI para continuar: ")).toUpperCase();
    if (answer !== "SI") stop("Cancelado. No se cambió nada.", 0);

    const hash = await bcrypt.hash(first, COST);
    await conn.beginTransaction();
    try {
      // Fechas en UTC, como las guarda la app.
      await conn.query("UPDATE `User` SET passwordHash = ?, failedLogins = 0, lockedUntil = NULL, updatedAt = UTC_TIMESTAMP(3) WHERE id = ?", [hash, user.id]);
      const closed = await conn.query("DELETE FROM `Session` WHERE userId = ?", [user.id]);
      await conn.query("INSERT INTO `AuditLog` (id, userId, action, target, detail, createdAt) VALUES (?, NULL, 'user.password_reset_cli', ?, ?, UTC_TIMESTAMP(3))", [
        `c${randomBytes(12).toString("hex")}`,
        user.email,
        JSON.stringify({ via: "terminal" }),
      ]);
      await conn.commit();
      console.log(`\nListo: la contraseña de ${user.email} quedó cambiada${Number(closed.affectedRows) > 0 ? ` y se cerraron ${Number(closed.affectedRows)} sesión(es) abiertas` : ""}.`);
      console.log("Entra con ella y, si quieres otra, cámbiala en Perfil.");
    } catch (e) {
      await conn.rollback().catch(() => undefined);
      throw e;
    }
  } catch (e) {
    if (e instanceof Error && e.message === "cancelado") stop("Cancelado. No se cambió nada.", 0);
    stop(`No se pudo cambiar la contraseña (${e?.code ?? e?.message ?? "error"}). No se cambió nada.`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

// Solo corre al ejecutarlo como comando; al importarlo (las pruebas) no hace nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
