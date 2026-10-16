import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Prisma genera las migraciones segun el MySQL donde corre. En Windows (MySQL no distingue mayusculas)
// escribe `ALTER TABLE \`socialaccount\``, y en el VPS (Linux, sí distingue) eso falla con "tabla no existe".
// Esta prueba exige que todo nombre de tabla use exactamente las mayusculas con las que se creo.

const root = path.resolve(import.meta.dirname, "../prisma/migrations");
const migrations = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, sql: readFileSync(path.join(root, d.name, "migration.sql"), "utf8") }));

// Tablas creadas por cualquier migracion, con su mayuscula exacta.
const created = new Set(migrations.flatMap((m) => [...m.sql.matchAll(/CREATE TABLE `([^`]+)`/g)].map((x) => x[1])));

describe("migraciones de Prisma", () => {
  it("hay migraciones y crean tablas", () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(created.size).toBeGreaterThan(0);
  });

  it("todo nombre de tabla usado coincide en mayusculas con el de su CREATE TABLE (importa en Linux)", () => {
    const wrong: string[] = [];
    for (const m of migrations) {
      const uses = [
        ...m.sql.matchAll(/ALTER TABLE `([^`]+)`/g),
        ...m.sql.matchAll(/CREATE (?:UNIQUE )?INDEX `[^`]+` ON `([^`]+)`/g),
        ...m.sql.matchAll(/DROP INDEX `[^`]+` ON `([^`]+)`/g),
        ...m.sql.matchAll(/REFERENCES `([^`]+)`/g),
        ...m.sql.matchAll(/DROP TABLE (?:IF EXISTS )?`([^`]+)`/g),
      ].map((x) => x[1]);
      for (const table of uses) {
        if (!created.has(table)) wrong.push(`${m.name}: \`${table}\``);
      }
    }
    expect(wrong, "Corrige las mayusculas a mano (ver CLAUDE.md)").toEqual([]);
  });
});
