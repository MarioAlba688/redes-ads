// Utilidades compartidas por las pruebas de extremo a extremo.
// Todas las pruebas trabajan SOLO contra una base cuyo nombre termine en "_test".

import { spawn } from "node:child_process";
import fs from "node:fs";
import mariadb from "mariadb";

/** Lee E2E_DATABASE_URL y se niega a seguir si no es una base de pruebas. */
export function requireTestDb() {
  const raw = process.env.E2E_DATABASE_URL;
  if (!raw) {
    console.error("Falta E2E_DATABASE_URL (ej. mysql://root:@127.0.0.1:3307/redes_test).");
    process.exit(2);
  }
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name.endsWith("_test")) {
    console.error(`Por seguridad, la base de datos debe terminar en "_test" (recibido: "${name}").`);
    process.exit(2);
  }
  return { raw, url, name };
}

export function createDb(url) {
  const config = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
  async function withConn(fn) {
    const c = await mariadb.createConnection(config);
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  return {
    sql: (q, params = []) => withConn((c) => c.query(q, params)),
    /** Vacia todas las tablas (menos el historial de migraciones). Solo se llama tras requireTestDb(). */
    async reset() {
      await withConn(async (c) => {
        const tables = await c.query(
          "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations'",
        );
        await c.query("SET FOREIGN_KEY_CHECKS = 0");
        for (const t of tables) await c.query(`TRUNCATE TABLE \`${t.n}\``);
        await c.query("SET FOREIGN_KEY_CHECKS = 1");
      });
    },
  };
}

export function findChrome() {
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

export function createChecker() {
  const results = [];
  return {
    check(name, ok, extra = "") {
      results.push({ name, ok: !!ok, extra });
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
    },
    fail(name, extra) {
      results.push({ name, ok: false, extra });
      console.log(`FAIL  ${name}  -> ${extra}`);
    },
    /** Imprime el resumen y devuelve el codigo de salida. */
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${results.length - failed.length}/${results.length} pruebas OK`);
      if (failed.length) {
        console.log("FALLARON:");
        for (const f of failed) console.log(" -", f.name, f.extra);
      }
      return failed.length ? 1 : 0;
    },
  };
}

/**
 * Arranca `next start` (hay que haber hecho `npm run build`) y guarda sus ultimas lineas de salida en `logs`,
 * para mostrarlas si la prueba falla.
 */
export function startApp({ root, port, env, logs }) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    cwd: root,
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

export async function waitReady(base) {
  const ok = await waitFor(
    async () => {
      try {
        return (await fetch(`${base}/login`, { redirect: "manual" })).status < 500;
      } catch {
        return false;
      }
    },
    { timeout: 60_000, interval: 700 },
  );
  if (!ok) throw new Error(`La app no respondio en ${base}`);
}

/** Reintenta `fn` hasta que devuelva un valor verdadero o se agote el tiempo. */
export async function waitFor(fn, { timeout = 30_000, interval = 500 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}
