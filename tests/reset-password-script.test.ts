import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatabaseUrl as appParse } from "@/lib/db-config";
import { passwordSchema } from "@/lib/password";
import { parseDatabaseUrl as scriptParse, passwordProblem } from "../scripts/reset-password.mjs";

// scripts/reset-password.mjs no puede importar el codigo de la app (usa «server-only»), asi que repite dos cosas:
// como se lee DATABASE_URL y las reglas de la contraseña. Estas pruebas aseguran que no se separen.

describe("scripts/reset-password.mjs sigue las mismas reglas que la app", () => {
  it("lee DATABASE_URL igual que src/lib/db-config.ts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "redes-ca-"));
    const ca = path.join(dir, "ca.pem");
    writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nfalso\n-----END CERTIFICATE-----\n");
    try {
      for (const url of [
        "mysql://root:clave@localhost:3306/redes",
        "mysql://usuario:cl%23ve%40x@mi-vps.example.com/db-redes",
        "mysql://u:p@10.0.0.5:3307/db?sslaccept=strict",
        "mysql://u:p@host.example.com/db?sslaccept=accept_invalid_certs",
        `mysql://u:p@host.example.com/db?sslaccept=strict&sslcert=${encodeURIComponent(ca)}`,
      ]) {
        expect(scriptParse(url), url).toEqual(appParse(url));
      }
      expect(scriptParse("mysql://u:cl%23ve@h/db")).toMatchObject({ password: "cl#ve", port: 3306, database: "db", ssl: undefined });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rechaza lo mismo que la app en DATABASE_URL", () => {
    for (const url of ["mysql://u:p@h/db?sslaccept=raro", "mysql://u:p@h/db?sslcert=/no/existe/ca.pem"]) {
      expect(() => scriptParse(url)).toThrow();
      expect(() => appParse(url)).toThrow();
    }
  });

  it("acepta y rechaza las mismas contraseñas que passwordSchema", () => {
    const samples = [
      "corta1",
      "sinnumerosaqui",
      "1234567890123",
      "buena-clave-2026",
      "Contraseña2026ñ",
      "a1".repeat(36), // 72 bytes justos
      "a1".repeat(37), // 74 bytes
      "ñ1".repeat(20) + "ab", // 62 caracteres, 82 bytes
      "          1a", // espacios y letra y numero
      "",
    ];
    for (const s of samples) {
      expect(passwordProblem(s) === null, `«${s}»`).toBe(passwordSchema.safeParse(s).success);
    }
  });
});
