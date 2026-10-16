import "server-only";
import { readFileSync } from "node:fs";

export type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: { rejectUnauthorized: boolean; ca?: Buffer };
};

/**
 * Convierte DATABASE_URL en la configuracion del driver de MySQL.
 *
 * TLS para MySQL remoto (p. ej. en un VPS). Usa los mismos parametros que entiende
 * el CLI de Prisma, asi una sola URL sirve para la app y para las migraciones:
 *   ?sslaccept=strict               cifra y valida el certificado del servidor
 *   ?sslaccept=accept_invalid_certs cifra pero NO valida el certificado (vulnerable a MITM)
 *   &sslcert=/ruta/ca.pem           CA con la que validar (certificados propios)
 * Sin ninguno de los dos, la conexion va sin cifrar: solo aceptable en localhost o red privada.
 *
 * El usuario, la clave y el nombre de la base se decodifican (%23 -> #), asi que las
 * claves con simbolos deben ir codificadas en la URL.
 */
export function parseDatabaseUrl(databaseUrl: string): DbConfig {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: sslFromUrl(url),
  };
}

function sslFromUrl(url: URL): DbConfig["ssl"] {
  const mode = url.searchParams.get("sslaccept");
  const caPath = url.searchParams.get("sslcert");
  if (!mode && !caPath) return undefined;
  if (mode && mode !== "strict" && mode !== "accept_invalid_certs") {
    throw new Error('DATABASE_URL: sslaccept debe ser "strict" o "accept_invalid_certs".');
  }

  let ca: Buffer | undefined;
  if (caPath) {
    try {
      ca = readFileSync(caPath);
    } catch {
      throw new Error(`DATABASE_URL: no pude leer el certificado indicado en sslcert (${caPath}).`);
    }
  }
  return { rejectUnauthorized: mode !== "accept_invalid_certs", ...(ca ? { ca } : {}) };
}
