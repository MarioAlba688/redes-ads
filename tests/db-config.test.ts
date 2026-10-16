import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "@/lib/db-config";

const dir = mkdtempSync(path.join(tmpdir(), "redes-db-"));
const caFile = path.join(dir, "ca.pem");
writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nfalso\n-----END CERTIFICATE-----\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseDatabaseUrl", () => {
  it("lee host, puerto, usuario, clave y base (con guion en el nombre)", () => {
    expect(parseDatabaseUrl("mysql://root:secreta@192.0.2.10:3307/db-redes")).toEqual({
      host: "192.0.2.10",
      port: 3307,
      user: "root",
      password: "secreta",
      database: "db-redes",
      ssl: undefined,
    });
  });

  it("usa el puerto 3306 si no se indica", () => {
    expect(parseDatabaseUrl("mysql://root:x@localhost/redes").port).toBe(3306);
  });

  it("decodifica claves con simbolos", () => {
    const pw = "Cl4ve@con:s/ímbolos#1%";
    const cfg = parseDatabaseUrl(`mysql://app:${encodeURIComponent(pw)}@localhost/redes`);
    expect(cfg.password).toBe(pw);
  });

  it("sin parametros ssl, la conexion no se cifra", () => {
    expect(parseDatabaseUrl("mysql://root:x@localhost/redes").ssl).toBeUndefined();
  });

  it("sslaccept=strict valida el certificado", () => {
    expect(parseDatabaseUrl("mysql://r:x@h/db?sslaccept=strict").ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("sslaccept=accept_invalid_certs cifra sin validar", () => {
    expect(parseDatabaseUrl("mysql://r:x@h/db?sslaccept=accept_invalid_certs").ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("sslcert carga la CA y valida por defecto", () => {
    const ssl = parseDatabaseUrl(`mysql://r:x@h/db?sslcert=${encodeURIComponent(caFile)}`).ssl;
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(ssl?.ca?.toString()).toContain("BEGIN CERTIFICATE");
  });

  it("sslaccept=strict junto con sslcert", () => {
    const ssl = parseDatabaseUrl(`mysql://r:x@h/db?sslaccept=strict&sslcert=${encodeURIComponent(caFile)}`).ssl;
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    expect(ssl?.ca).toBeInstanceOf(Buffer);
  });

  it("rechaza un valor de sslaccept desconocido", () => {
    expect(() => parseDatabaseUrl("mysql://r:x@h/db?sslaccept=cualquiera")).toThrow(/sslaccept/);
  });

  it("da un error claro si no encuentra el certificado", () => {
    expect(() => parseDatabaseUrl("mysql://r:x@h/db?sslcert=/no/existe.pem")).toThrow(/no pude leer el certificado/);
  });

  it("ignora parametros que no son de TLS", () => {
    expect(parseDatabaseUrl("mysql://r:x@h/db?connection_limit=5").ssl).toBeUndefined();
  });
});
